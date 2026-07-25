/**
 * Decide whether a PowerShell script can change anything, so read-only work runs
 * without friction while real changes still require confirmation.
 *
 * SECURITY MODEL: default-deny. A script is only declared read-only when EVERY
 * command in it is recognisably read-only. Anything unknown counts as mutating,
 * because a wrong "read-only" verdict makes src/tools/powershell.ts skip the
 * confirmation guard entirely (and thereby the READ_ONLY switch), while a wrong
 * "mutating" verdict only costs one extra confirmation.
 *
 * The rules, and why they exist:
 * - Verb allow-list, not a mutating-verb deny-list: unknown-but-conventional
 *   cmdlets (Get-Whatever from a third-party module) still pass, while non
 *   Verb-Noun mutations (`del`, `rm`, `[System.IO.File]::Delete`, `>`) cannot
 *   slip through a gap in a verb list.
 * - An always-mutating deny-list wins over every other rule, including -WhatIf,
 *   because `-WhatIf` only applies to the command it is written on and many of
 *   these entries (aliases, redirection, .NET statics) ignore it completely.
 * - -WhatIf only counts when it is affirmative and present on every command we
 *   could not otherwise vouch for: `-WhatIf:$false` is an override that turns the
 *   dry run back into a real change, and one `-WhatIf` on line 1 says nothing
 *   about line 2.
 * - Member access (`$x.Delete()`, `[Type]::Create()`, `(Get-Item x).Delete()`) is
 *   judged with the same allow-list philosophy: only members we can personally
 *   vouch for as pure computation stay read-only, every other and every unknown
 *   member call is mutating. Enumerating dangerous methods is unwinnable: the set
 *   of types (and therefore of methods) reachable from PowerShell is open-ended.
 *   Property reads without parentheses stay read-only, otherwise every reporting
 *   script ($user.DisplayName) would need a confirmation; a short list of member
 *   names that are dangerous by their very name is flagged even without parens.
 * - Whatever can compile or evaluate code from a string ($ExecutionContext,
 *   InvokeScript, [scriptblock]::Create, reflection, Add-Type -TypeDefinition,
 *   iex) is always mutating: what it runs is invisible to any analysis, so no
 *   -WhatIf on the visible text says anything about it.
 * - For the HTTP cmdlets the read-only verdict requires a *provable* GET. A method
 *   that arrives through a variable, a subexpression or a splat is not provable,
 *   so it is mutating. Same for any splat on a command whose safety depends on its
 *   parameters: @params hides the parameters from the script text entirely.
 * - Comments and string literals are removed by a single-pass lexer (O(n), no
 *   backtracking regex), so commented-out code does not trigger and `"-WhatIf"`
 *   inside a string cannot fake a dry run. Subexpressions inside double-quoted
 *   strings ARE kept, because "$(Remove-Item x)" really executes.
 * - Scripts larger than MAX_ANALYSED_CHARS are declared mutating without being
 *   analysed: we cannot vouch for what we did not inspect, and unbounded parsing
 *   of hostile input would block Node's single event loop for every other caller.
 */

/** Above this size we refuse to vouch for the script instead of analysing it. */
const MAX_ANALYSED_CHARS = 200_000;

/** How deep "$( ... )" inside a string is still followed; deeper counts as mutating. */
const MAX_SUBEXPRESSION_DEPTH = 16;

/** Verbs that never change state. Applies to any noun unless listed elsewhere. */
const READONLY_VERBS = new Set([
  "get",
  "measure",
  "test",
  "find",
  "search",
  "show",
  "select",
  "where",
  "sort",
  "group",
  "compare",
  "convertto",
  "convertfrom",
  "join",
  "split",
  "read",
  "resolve",
  "connect",
  "disconnect",
  "enter",
  "exit",
  "foreach",
]);

/**
 * Verbs where safety depends on the noun. Everything not listed per verb is
 * mutating: Format-Volume wipes a disk, Out-File writes one, Write-EventLog
 * writes to the event log, Import-PfxCertificate installs a certificate.
 */
const CONDITIONAL_VERB_NOUNS: Record<string, Set<string>> = {
  // Only the display formatters.
  format: new Set(["table", "list", "wide", "custom"]),
  // Only the sinks that do not persist anything.
  out: new Set(["string", "host", "null", "gridview"]),
  // Only the host/stream writers, never data writers.
  write: new Set([
    "output",
    "host",
    "verbose",
    "debug",
    "information",
    "warning",
    "progress",
    "error",
  ]),
  // Only importing data into the session, never into a store.
  import: new Set(["module", "csv", "clixml", "localizeddata", "powershelldatafile", "alias"]),
};

/**
 * Commands whose verb looks mutating but which only touch memory or the current
 * session, plus the common read-only aliases (which are not Verb-Noun and would
 * otherwise be rejected as unknown).
 */
const SAFE_COMMANDS = new Set([
  // session/memory only
  "new-object",
  "new-timespan",
  "new-guid",
  "new-variable",
  "new-alias",
  "new-pssessionoption",
  "add-type",
  "add-member",
  "set-location",
  "set-strictmode",
  "set-variable",
  "set-alias",
  "set-psdebug",
  "clear-host",
  "clear-variable",
  "start-sleep",
  "invoke-history",
  // read-only aliases
  "ls",
  "dir",
  "gci",
  "gi",
  "gc",
  "cat",
  "type",
  "gp",
  "gl",
  "pwd",
  "cd",
  "sl",
  "chdir",
  "echo",
  "write",
  "select",
  "where",
  "?",
  "%",
  "sort",
  "group",
  "measure",
  "ft",
  "fl",
  "fw",
  "gm",
  "gcm",
  "gsv",
  "gps",
  "ps",
  "sls",
  "gv",
  "gal",
  "gdr",
  "gu",
  "oh",
  "ogv",
  "h",
  "history",
  "man",
  "help",
]);

/**
 * Always mutating, wins over every other rule. Mostly aliases and non Verb-Noun
 * commands that a verb-based check cannot see, plus the invocation commands that
 * can run arbitrary hidden code.
 */
const ALWAYS_MUTATING = new Set([
  // destructive aliases
  "del",
  "erase",
  "rd",
  "rmdir",
  "md",
  "mkdir",
  "ri",
  "rm",
  "rmo",
  "mv",
  "move",
  "cp",
  "copy",
  "ni",
  "si",
  "sp",
  "sc",
  "ac",
  "clc",
  "cli",
  "cpi",
  "mi",
  "rni",
  "spps",
  "spsv",
  "kill",
  "clear",
  "ii",
  // invocation aliases: can run anything, including code we never see
  "iex",
  "icm",
  "saps",
  "sajb",
  // explicit cmdlets (most are already covered by the verb rules; listed so the
  // verdict beats -WhatIf and so `because` can name them)
  "invoke-expression",
  "invoke-command",
  "invoke-item",
  "start-process",
  "start-job",
  "send-mailmessage",
  "send-mgusermail",
  "format-volume",
  "out-file",
  "out-printer",
  "write-eventlog",
  "set-content",
  "add-content",
  "clear-content",
  "set-item",
  "set-itemproperty",
  "new-itemproperty",
  "remove-itemproperty",
  "new-item",
  "remove-item",
  "rename-item",
  "move-item",
  "copy-item",
  "clear-item",
  "tee-object",
  "tee",
]);

/**
 * HTTP cmdlets and their aliases: read-only for a plain GET, mutating as soon as
 * a write method, an output file or a download flag appears. Piping the result
 * into `iex` is caught separately, because `iex` itself is always mutating.
 */
const HTTP_COMMANDS = new Set([
  "invoke-restmethod",
  "invoke-webrequest",
  "irm",
  "iwr",
  "curl",
  "wget",
  // Same category, and the workhorse of this server's domain: a GET against Graph
  // is a read, anything else is not.
  "invoke-mggraphrequest",
]);

/**
 * Commands that take the HTTP method positionally (Invoke-MgGraphRequest POST /users),
 * so a `-Method` check alone would miss the write.
 */
const POSITIONAL_METHOD_COMMANDS = new Set(["invoke-mggraphrequest"]);
const BARE_WRITE_METHOD = /\b(?:POST|PUT|PATCH|DELETE)\b/i;

/** PowerShell language keywords, never commands. */
const KEYWORDS = new Set([
  "if",
  "elseif",
  "else",
  "switch",
  "default",
  "for",
  "while",
  "do",
  "until",
  "break",
  "continue",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  "trap",
  "function",
  "filter",
  "workflow",
  "configuration",
  "class",
  "enum",
  "param",
  "begin",
  "process",
  "end",
  "dynamicparam",
  "data",
  "in",
  "using",
  "hidden",
  "static",
  "not",
]);

/**
 * `-Method POST` and friends, also in the `-Method:POST` form.
 *
 * Every quantifier in this file is bounded ({0,n} instead of *) and never spans
 * newlines. An unbounded \s* next to another quantifier backtracks quadratically
 * on hostile whitespace, which is exactly the denial of service this module has
 * to avoid: analysis runs on unvalidated input on Node's single event loop.
 */
const METHOD_PARAM = /-Method\b[ \t]{0,4}:?[ \t]{0,4}(\S{1,40})?/i;
const METHOD_PARAM_ALL = /-Method\b[ \t]{0,4}:?[ \t]{0,4}(\S{1,40})?/gi;
/**
 * The ONLY method value we accept as read-only: a literal GET. `$m`, `$(...)`,
 * `''` (a string the lexer could not vouch for) and every other verb fail this
 * test, because "not provably GET" has to mean mutating: the old check looked for
 * a literal POST/PUT/PATCH/DELETE, so `-Method $m` with $m='DELETE' passed as a
 * read.
 */
const PROVABLE_GET = /^['"]?GET['"]?[,;]?$/i;
/** Writing the response to disk is a change, whatever the HTTP method is. */
const OUT_FILE_PARAM = /-OutFile\b/i;
/** curl/wget style write flags, for when these resolve to the real binaries. */
const CURL_WRITE =
  /(?:^|[ \t])(?:-X[ \t]{0,4}['"]?(?:POST|PUT|PATCH|DELETE)\b|-o\b|-O\b|--output\b|--remote-name\b)/i;

/**
 * An affirmative -WhatIf. `-WhatIf:$false` / `:0` re-enable the real change, so
 * they must not read as a dry run. `\b` keeps -WhatIfPreference out.
 */
const AFFIRMATIVE_WHATIF = /-WhatIf\b(?![ \t]{0,4}:[ \t]{0,4}(?:\$false|0\b))/i;

/**
 * Members we are willing to vouch for: pure computation on a value that is
 * already in memory. Every OTHER member call, including every member we have
 * never heard of, counts as mutating.
 *
 * This direction is deliberate. A deny-list of dangerous methods cannot work:
 * PowerShell reaches the entire .NET surface plus every loaded module type, so
 * `.Delete()`, `.MoveTo()`, `.DownloadFile()`, `.SetInfo()`, `.CommitChanges()`,
 * `[Activator]::CreateInstance()` and thousands of others would all have to be
 * listed, and one gap silently skips the confirmation prompt. Vouching only for
 * string/date/math/reflection-free helpers is a list we can actually verify.
 */
const SAFE_MEMBERS = new Set([
  // string inspection and manipulation
  "tostring",
  "trim",
  "trimstart",
  "trimend",
  "substring",
  "split",
  "replace",
  "indexof",
  "lastindexof",
  "startswith",
  "endswith",
  "contains",
  "containskey",
  "equals",
  "toupper",
  "tolower",
  "toupperinvariant",
  "tolowerinvariant",
  "padleft",
  "padright",
  "tochararray",
  "compareto",
  "isnullorempty",
  "isnullorwhitespace",
  "format",
  "join",
  "concat",
  // size and identity, never a write
  "length",
  "count",
  "gettype",
  "gethashcode",
  "toarray",
  // the PowerShell intrinsic filters. Their scriptblock body is a separate
  // segment, so anything mutating inside it is still classified on its own.
  // .ForEach() is deliberately NOT here: .ForEach('Delete') invokes a method by
  // name on every element, which is exactly the hole we are closing.
  "where",
  "select",
  // pure date/time arithmetic, the backbone of "last 30 days" reports
  "adddays",
  "addhours",
  "addminutes",
  "addseconds",
  "addmilliseconds",
  "addmonths",
  "addyears",
  "addticks",
  "subtract",
  "touniversaltime",
  "tolocaltime",
  "parse",
  "tryparse",
  "parseexact",
  // pure math and encoding helpers
  "round",
  "floor",
  "ceiling",
  "truncate",
  "abs",
  "max",
  "min",
  "pow",
  "sqrt",
  "newguid",
  "tobase64string",
  "frombase64string",
  "getstring",
  "getbytes",
  "escapedatastring",
  "unescapedatastring",
  "ismatch",
  "matches",
  // path arithmetic: string work on a path, it never touches the file system
  "combine",
  "getfilename",
  "getfilenamewithoutextension",
  "getextension",
  "getdirectoryname",
]);

/**
 * Members that are mutating even without parentheses. A bare `$x.Delete` is only
 * a method reference, but the names below have no innocent reading in this
 * context, and writing `$x.Delete ()` (space before the paren) or passing the
 * reference on would otherwise dodge the "followed by (" test.
 */
const DANGEROUS_MEMBERS = new Set([
  "delete",
  "remove",
  "removeall",
  "kill",
  "dispose",
  "close",
  "save",
  "commit",
  "commitchanges",
  "moveto",
  "copyto",
  "deleteobject",
  "setvalue",
  "setinfo",
  "setaccesscontrol",
  // code generation / reflection: these run code we cannot see
  "invoke",
  "invokescript",
  "invokemember",
  "invokecommand",
  "newscriptblock",
  "getmethod",
  "getmethods",
  "getproperty",
  "getproperties",
  "createinstance",
  // network transfer
  "downloadstring",
  "downloaddata",
  "downloadfile",
  "uploadstring",
  "uploaddata",
  "uploadfile",
]);

/** Only these types get the "printing to the host is harmless" exemption. */
const CONSOLE_TYPES = new Set(["[console]", "[system.console]"]);

/**
 * $ExecutionContext exposes the engine itself (InvokeCommand.InvokeScript,
 * NewScriptBlock): it can execute any string. There is no read-only use of it in
 * an admin script, so its mere presence is hard evidence and beats -WhatIf.
 */
const EXECUTION_CONTEXT = /\$ExecutionContext\b/i;

/**
 * Add-Type compiles and loads arbitrary code when it is given source or an
 * assembly path, which is unbounded execution. -AssemblyName (loading a shipped
 * framework assembly) stays safe, because that is the common read-only use.
 */
const ADD_TYPE_CODE = /-(?:TypeDefinition|MemberDefinition|Path|LiteralPath)\b/i;

/**
 * A splatted parameter set: `Invoke-MgGraphRequest @params`. The parameters live
 * in a hash table, so the script text shows nothing about the HTTP method, the
 * output file, or a -WhatIf:$false override. For every command whose safety
 * depends on its parameters this means we cannot vouch for it.
 * `@(` and `@{` are literals, not splats, so a letter/underscore is required.
 */
const SPLAT_ARGUMENT = /(?:^|[ \t])@[A-Za-z_][A-Za-z0-9_:]{0,64}/;

/**
 * Output redirection. `-gt`/`-ge` contain no `>` so they are safe by
 * construction; stream merges (`2>&1`) and `> $null` are exempt because neither
 * can persist data anywhere.
 */
const REDIRECTION = /(?:\d|\*)?>>?(?![ \t]{0,4}&[ \t]{0,4}\d)(?![ \t]{0,4}\$null\b)/;

export interface ScriptAnalysis {
  mutating: boolean;
  /** Short explanation for the context header and confirmation prompt. */
  because: string;
  /** Cmdlets, aliases or patterns that triggered the verdict. */
  matches: string[];
  /** True when the verdict is read-only because every risky command uses -WhatIf. */
  dryRun: boolean;
  /** True when the script was rejected unanalysed because of its size. */
  tooLarge: boolean;
}

/**
 * A quoted string is replaced by a harmless empty literal, EXCEPT when its whole
 * content is one short plain word: then the word is kept inside quotes.
 *
 * Why: `-Method 'GET'` must remain provably a GET, and `-Method 'DELETE'` must
 * remain visibly not a GET. Keeping only /^[A-Za-z]{1,16}$/ cannot smuggle code
 * back in: no spaces, no `$`, no dots, no parentheses, no `>`, no hyphen, so it
 * can never form a command, a member call, a parameter or a redirection. The
 * quotes are kept so the token still reads as a literal, not as a command name.
 */
const SIMPLE_WORD = /^[A-Za-z]{1,16}$/;

function literalToken(raw: string): string {
  return SIMPLE_WORD.test(raw) ? `'${raw}'` : "''";
}

interface StripResult {
  code: string;
  /** A comment or string that never ends: the script cannot be trusted or run. */
  broken: boolean;
}

/**
 * Remove comments and string literals in a single left-to-right pass.
 * O(n): every character is consumed exactly once, so an 80 KB script costs 80 K
 * steps instead of the quadratic backtracking of the previous regex.
 */
function stripCommentsAndStrings(src: string, depth = 0): StripResult {
  let out = "";
  let broken = false;
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    // Block comment <# ... #>
    if (c === "<" && src[i + 1] === "#") {
      const end = src.indexOf("#>", i + 2);
      if (end < 0) {
        broken = true;
        break;
      }
      out += " ";
      i = end + 2;
      continue;
    }

    // Line comment. Only when `#` starts a token, so a URL fragment such as
    // https://host/page#anchor does not swallow the rest of the line.
    if (c === "#") {
      const prev = i === 0 ? "\n" : src[i - 1];
      if (prev === "\n" || prev === "\r" || prev === " " || prev === "\t" || prev === ";") {
        const nl = src.indexOf("\n", i);
        out += "\n";
        if (nl < 0) break;
        i = nl + 1;
        continue;
      }
    }

    // Single-quoted string: literal, only '' escapes.
    if (c === "'") {
      const contentStart = i + 1;
      i += 1;
      let closed = false;
      let contentEnd = i;
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            i += 2;
            continue;
          }
          contentEnd = i;
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        broken = true;
        break;
      }
      out += literalToken(src.slice(contentStart, contentEnd));
      continue;
    }

    // Double-quoted string: backtick escapes, "" escapes, and $( ) subexpressions
    // that really execute and therefore must stay visible to the analysis.
    if (c === '"') {
      const contentStart = i + 1;
      i += 1;
      let closed = false;
      let contentEnd = i;
      // A string that contained an escape or a subexpression is never kept as a
      // literal word: its real value is not the text we saw.
      let plain = true;
      while (i < n) {
        const d = src[i];
        if (d === "`") {
          plain = false;
          i += 2;
          continue;
        }
        if (d === "$" && src[i + 1] === "(") {
          plain = false;
          // Bounded recursion: "$("$("$(... would otherwise cost one stack frame and
          // one extra pass over the tail per level, i.e. a stack overflow plus
          // quadratic work on hostile input. Past the limit we stop vouching.
          const inner = depth >= MAX_SUBEXPRESSION_DEPTH ? undefined : readBalanced(src, i + 1);
          if (inner === undefined) {
            broken = true;
            break;
          }
          const innerResult = stripCommentsAndStrings(inner.text, depth + 1);
          // A broken nested subexpression makes the whole script un-vouchable.
          if (innerResult.broken) {
            broken = true;
            break;
          }
          out += ` ; ${innerResult.code} ; `;
          i = inner.end;
          continue;
        }
        if (d === '"') {
          if (src[i + 1] === '"') {
            plain = false;
            i += 2;
            continue;
          }
          contentEnd = i;
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (broken) break;
      if (!closed) {
        broken = true;
        break;
      }
      out += plain ? literalToken(src.slice(contentStart, contentEnd)) : "''";
      continue;
    }

    out += c;
    i += 1;
  }

  return { code: out, broken };
}

/** Read `( ... )` starting at `open`, returning the inner text and the index after `)`. */
function readBalanced(src: string, open: number): { text: string; end: number } | undefined {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return { text: src.slice(open + 1, i), end: i + 1 };
    }
  }
  return undefined;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

/** How far back a `[Type]` literal in front of `::` or `.` is still read. */
const MAX_TYPE_LITERAL = 200;

/**
 * True when this character can end an expression that a member can be called on:
 * a variable or identifier (word character), a `$`, a closing parenthesis
 * (`(Get-Item x).Delete()`), a closing bracket (`[System.IO.File].GetMethod()`,
 * `$a[0].Delete()`), a closing brace (a pipeline/scriptblock result) or a quote
 * (a string literal). Anything else (`*`, whitespace, an operator) means the dot
 * is not member access, e.g. `*.txt` or a decimal number.
 */
function isReceiverEnd(ch: string): boolean {
  return (
    ch === ")" || ch === "]" || ch === "}" || ch === "'" || ch === '"' || ch === "$" || NAME_CHAR.test(ch)
  );
}

/**
 * The `[Type]` literal directly in front of the operator, lowercased and with its
 * brackets, or "" when the receiver is not a type literal. The backward scan is
 * bounded by MAX_TYPE_LITERAL and stops at a newline, so it stays linear.
 */
function receiverType(code: string, opIndex: number): string {
  if (code[opIndex - 1] !== "]") return "";
  const floor = Math.max(0, opIndex - 1 - MAX_TYPE_LITERAL);
  for (let k = opIndex - 2; k >= floor; k -= 1) {
    const ch = code[k];
    if (ch === "\n" || ch === "\r" || ch === "]") return "";
    if (ch === "[") return code.slice(k, opIndex).toLowerCase();
  }
  return "";
}

/**
 * True when the argument list starting at `open` is empty: `(` optionally followed
 * by spaces and then `)`. Used for `[Type]::new()` only.
 *
 * WHY this narrow exception: `[SomeType]::new()` is the modern spelling of
 * New-Object, which this module already considers safe, and a PARAMETERLESS
 * constructor can only allocate an in-memory object. As soon as arguments appear
 * it is no longer vouchable: `[System.IO.StreamWriter]::new('C:\x')` truncates a
 * file at construction time, so `::new(<anything>)` stays mutating.
 */
function hasEmptyArgumentList(code: string, open: number): boolean {
  for (let k = open + 1; k < code.length && k - open <= 8; k += 1) {
    const ch = code[k];
    if (ch === ")") return true;
    if (ch !== " " && ch !== "\t") return false;
  }
  return false;
}

/**
 * Collect every member access we cannot vouch for, in one left-to-right pass over
 * the stripped code (O(n), no regex over the whole text).
 *
 * A member FOLLOWED BY `(` is an invocation: allow-listed members pass, every
 * other one is evidence. A member WITHOUT parentheses is a property read and
 * stays read-only, because $user.DisplayName / $_.Name are the bread and butter
 * of read-only reporting; only the names in DANGEROUS_MEMBERS are flagged there.
 */
function findMemberEvidence(code: string): string[] {
  const found = new Set<string>();
  const n = code.length;
  let i = 0;

  while (i < n) {
    const c = code[i];
    if (c !== "." && c !== ":") {
      i += 1;
      continue;
    }
    const isStatic = c === ":" && code[i + 1] === ":";
    if (c === ":" && !isStatic) {
      i += 1;
      continue;
    }
    const opLen = isStatic ? 2 : 1;
    if (i === 0 || !isReceiverEnd(code[i - 1])) {
      i += opLen;
      continue;
    }
    const start = i + opLen;
    if (start >= n || !NAME_START.test(code[start])) {
      i += opLen;
      continue;
    }
    let j = start + 1;
    while (j < n && j - start < 128 && NAME_CHAR.test(code[j])) j += 1;

    const member = code.slice(start, j);
    const lower = member.toLowerCase();
    const type = receiverType(code, i);
    const shown = `${type}${isStatic ? "::" : "."}${member}`;
    // [Console]::Write / ::WriteLine reach the host only, never a store.
    const consoleWrite = CONSOLE_TYPES.has(type) && lower.startsWith("write");

    if (code[j] === "(") {
      const emptyConstructor = isStatic && lower === "new" && hasEmptyArgumentList(code, j);
      if (!consoleWrite && !emptyConstructor && !SAFE_MEMBERS.has(lower)) {
        found.add(`aanroep van ${shown}() (methode niet op de lijst van bewezen leesbare leden)`);
      }
    } else if (DANGEROUS_MEMBERS.has(lower) && !consoleWrite) {
      found.add(`gebruik van ${shown} (lid dat kan wijzigen of code kan uitvoeren)`);
    }

    // Continue after the member name: the same pass then sees the next operator.
    i = j;
  }

  return [...found];
}

interface Segment {
  /** The statement text with the command name at the front. */
  text: string;
  /** The separator that introduced this segment, "" for the first one. */
  separator: string;
}

/**
 * Split the code into statement segments. Every command name sits at the start of
 * a segment, so arguments can never be mistaken for commands.
 */
function splitSegments(code: string): Segment[] {
  // A backtick before a newline continues the statement, so the next line does
  // NOT start a new command.
  const joined = code.replace(/`\r?\n/g, " ");
  // `&&` and `||` before the single-character alternatives, so they win.
  const parts = joined.split(/(\|\||&&|&|[\n\r;|(){}])/);
  const segments: Segment[] = [];
  let separator = "";
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) {
      segments.push({ text: parts[i], separator });
    } else {
      separator = parts[i];
    }
  }
  return segments;
}

/**
 * Strip what can precede a command name inside one statement. All patterns are
 * anchored and bounded, so this stays linear on hostile input.
 */
function commandOf(segment: string): string | undefined {
  let text = segment.trim();
  // Assignment to a variable: $result = Get-Thing
  text = text.replace(/^\$[^\s=]{0,128}[ \t]{0,8}[-+*/%]?=[ \t]{0,8}/, "");
  // Hash-table key or named argument: Path = Get-Location
  text = text.replace(/^[A-Za-z_][A-Za-z0-9_]{0,128}[ \t]{0,8}=(?!=)[ \t]{0,8}/, "");
  // Casts and attributes: [string] $x, [CmdletBinding()]. Bounded repetition in
  // one pass instead of a replace loop, which would copy the string every time.
  text = text.replace(/^(?:\[[^\][\r\n]{0,200}\][ \t]{0,8}){0,8}/, "");
  const token = /^\S{1,200}/.exec(text.trim());
  return token ? token[0] : undefined;
}

type TokenVerdict =
  | { kind: "safe" }
  | { kind: "ignore" }
  | { kind: "mutating"; evidence: string }
  | { kind: "unknown"; evidence: string };

/**
 * Zero-width and format characters plus every kind of Unicode space. They are
 * removed from a command token before it is looked up, so `i<ZWSP>ex` cannot hide
 * from the always-mutating list, and a token that consists of nothing else is
 * reported as unknown rather than silently ignored: we cannot say what a command
 * made of invisible characters does.
 */
const INVISIBLE_CHARS = /[\s\u00ad\u200b-\u200f\u2060\ufeff]/g;

interface CommandContext {
  /** The statement this command was found in. */
  segment: string;
  /** True when any -Method in the script has a value that is not provably GET. */
  nonGetMethodInScript: boolean;
}

function classifyCommand(rawToken: string, ctx: CommandContext): TokenVerdict {
  const trimmed = rawToken.replace(/[,;:]+$/, "");
  const token = trimmed.replace(INVISIBLE_CHARS, "");
  const lower = token.toLowerCase();
  const segmentText = ctx.segment;
  if (lower.length === 0) {
    // Nothing but whitespace: an empty segment, genuinely nothing to run.
    if (trimmed.length === 0) return { kind: "ignore" };
    // Something was there, but only invisible characters: default-deny.
    return { kind: "unknown", evidence: "commandonaam bestaat alleen uit onzichtbare tekens" };
  }

  // Not a command position: variables, literals, parameters, operators, splats.
  // A leading `:` is what is left of a [Type]::Member call, which the dedicated
  // .NET rule already judged.
  if (/^[$@0-9'".+\-*/=!<>:[\]{}]/.test(lower)) return { kind: "ignore" };
  if (lower === "--%") return { kind: "ignore" };

  if (ALWAYS_MUTATING.has(lower)) {
    return { kind: "mutating", evidence: token };
  }

  // Add-Type is only safe while it loads a shipped assembly. With source code or
  // an assembly path it compiles and runs whatever it is given, so it belongs with
  // the code-evaluation family and must beat -WhatIf. Checked before SAFE_COMMANDS
  // because "add-type" is listed there for the -AssemblyName case.
  if (lower === "add-type" && ADD_TYPE_CODE.test(segmentText)) {
    return { kind: "mutating", evidence: `${token} compileert en laadt eigen code` };
  }

  if (SAFE_COMMANDS.has(lower)) return { kind: "safe" };
  if (KEYWORDS.has(lower)) return { kind: "ignore" };

  if (HTTP_COMMANDS.has(lower)) {
    // A splat hides every parameter, including the method and -OutFile, so the
    // safety of this call simply cannot be read from the script.
    if (SPLAT_ARGUMENT.test(segmentText)) {
      return {
        kind: "mutating",
        evidence: `${token} met gesplatte parameters (@params verbergt de HTTP-methode)`,
      };
    }
    if (OUT_FILE_PARAM.test(segmentText)) {
      return { kind: "mutating", evidence: `${token} -OutFile schrijft naar schijf` };
    }
    if ((lower === "curl" || lower === "wget") && CURL_WRITE.test(segmentText)) {
      return { kind: "mutating", evidence: `${token} met schrijf- of downloadoptie` };
    }

    // The verdict may only stay read-only when the method is PROVABLY GET.
    const method = METHOD_PARAM.exec(segmentText);
    if (method) {
      const value = method[1] ?? "";
      if (!PROVABLE_GET.test(value)) {
        return {
          kind: "mutating",
          evidence: `${token} met niet-aantoonbaar lezende methode (-Method ${value || "zonder waarde"})`,
        };
      }
      return { kind: "safe" };
    }

    // No -Method in this statement. A positional method (Invoke-MgGraphRequest
    // DELETE /users/x) still counts, and so does a non-GET -Method anywhere else
    // in the script: statements are split on newlines, so a continued line could
    // have carried the method away from this segment.
    if (POSITIONAL_METHOD_COMMANDS.has(lower) && BARE_WRITE_METHOD.test(segmentText)) {
      return { kind: "mutating", evidence: `${token} met schrijf-methode (POST/PUT/PATCH/DELETE)` };
    }
    if (ctx.nonGetMethodInScript) {
      return {
        kind: "mutating",
        evidence: `${token} in een script met een niet-aantoonbaar lezende -Method`,
      };
    }
    // No method at all and no splat: the cmdlets default to GET.
    return { kind: "safe" };
  }

  // Verb-Noun, where the noun may carry digits, dots or extra hyphens so that
  // third-party names such as Get-Mg-Something still resolve to their verb.
  const verbNoun = /^([A-Za-z][A-Za-z0-9]*)-([A-Za-z0-9_.-]+)$/.exec(token);
  if (verbNoun) {
    const verb = verbNoun[1].toLowerCase();
    const noun = verbNoun[2].toLowerCase();
    const conditional = CONDITIONAL_VERB_NOUNS[verb];
    if (conditional) {
      return conditional.has(noun)
        ? { kind: "safe" }
        : { kind: "mutating", evidence: `${token} (geen lezende ${verbNoun[1]}-cmdlet)` };
    }
    if (READONLY_VERBS.has(verb)) return { kind: "safe" };
    return { kind: "unknown", evidence: token };
  }

  // Anything else: external programs, .ps1 files, unknown bare words. We cannot
  // tell what they do, so default-deny applies.
  return { kind: "unknown", evidence: token };
}

/**
 * True when the script contains a -Method whose value cannot be proven to be GET
 * ($m, $(...), '' or any other verb). Computed once per analysis with a bounded
 * regex in one sweep, so the per-command HTTP check stays O(1).
 */
function hasNonGetMethod(code: string): boolean {
  METHOD_PARAM_ALL.lastIndex = 0;
  for (const match of code.matchAll(METHOD_PARAM_ALL)) {
    if (!PROVABLE_GET.test(match[1] ?? "")) return true;
  }
  return false;
}

/**
 * One-entry memo. Every powershell_run is analysed twice (once by the context
 * header in index.ts, once by the tool handler); the function is pure, so the
 * second call can be free instead of paying the full scan again.
 */
let lastScript: string | undefined;
let lastAnalysis: ScriptAnalysis | undefined;

export function analyzeScript(script: string): ScriptAnalysis {
  const text = script ?? "";
  if (lastAnalysis !== undefined && lastScript === text) return lastAnalysis;
  const analysis = analyzeUncached(text);
  lastScript = text;
  lastAnalysis = analysis;
  return analysis;
}

function analyzeUncached(text: string): ScriptAnalysis {
  if (text.length > MAX_ANALYSED_CHARS) {
    return {
      mutating: true,
      because:
        `script is ${text.length} tekens en daarmee te groot om te controleren ` +
        `(limiet ${MAX_ANALYSED_CHARS}); niet-geanalyseerde code geldt als wijzigend`,
      matches: ["script te groot voor analyse"],
      dryRun: false,
      tooLarge: true,
    };
  }

  const stripped = stripCommentsAndStrings(text);
  if (stripped.broken) {
    return {
      mutating: true,
      because:
        "script bevat een niet-afgesloten string of commentaarblok, dus de inhoud " +
        "kan niet betrouwbaar worden gecontroleerd",
      matches: ["niet-afgesloten string of commentaar"],
      dryRun: false,
      tooLarge: false,
    };
  }
  const code = stripped.code;
  const nonGetMethodInScript = hasNonGetMethod(code);

  /** Evidence that wins over -WhatIf. */
  const hard = new Set<string>();
  /** Commands we simply cannot vouch for; -WhatIf can still excuse these. */
  const unknown = new Set<string>();
  const safeSeen = new Set<string>();
  /** Segments holding an unknown command without an affirmative -WhatIf. */
  let unguardedUnknown = 0;

  // Member access on variables, type literals, parenthesised expressions and
  // pipeline results. Hard evidence: -WhatIf is a cmdlet parameter and has no
  // effect whatsoever on a .NET method call.
  for (const evidence of findMemberEvidence(code)) hard.add(evidence);

  // The engine intrinsic itself: $ExecutionContext.InvokeCommand.InvokeScript()
  // executes any string, so nothing about the visible script text is a guarantee.
  if (EXECUTION_CONTEXT.test(code)) {
    hard.add("$ExecutionContext (kan willekeurige code uitvoeren)");
  }

  if (REDIRECTION.test(code)) {
    hard.add("uitvoer-omleiding (> of >>) schrijft naar een bestand");
  }

  for (const segment of splitSegments(code)) {
    const token = commandOf(segment.text);
    if (token === undefined) continue;

    // `&` is the call operator. `& $exe` or `& 'name'` hides the command name, so
    // there is nothing left to recognise.
    if (segment.separator === "&" && /^[$'"]/.test(token)) {
      hard.add("call-operator & met een dynamische commandonaam");
      continue;
    }
    // Dot-sourcing runs a whole other file in this session.
    if (token === "." || token.startsWith(".\\") || token.startsWith("./")) {
      hard.add(`uitvoeren van een extern script (${token})`);
      continue;
    }

    const verdict = classifyCommand(token, {
      segment: segment.text,
      nonGetMethodInScript,
    });
    if (verdict.kind === "mutating") hard.add(verdict.evidence);
    else if (verdict.kind === "safe") safeSeen.add(token);
    else if (verdict.kind === "unknown") {
      unknown.add(verdict.evidence);
      // -WhatIf only covers the command it is written on, so it has to be present
      // in this very segment. A splat next to it does not count either: the hash
      // table can contain WhatIf=$false and turn the dry run back into a change.
      const dryRun =
        AFFIRMATIVE_WHATIF.test(segment.text) && !SPLAT_ARGUMENT.test(segment.text);
      if (!dryRun) unguardedUnknown += 1;
    }
  }

  // 1. Hard evidence always wins, including over -WhatIf.
  if (hard.size > 0) {
    const list = [...hard];
    return {
      mutating: true,
      because: `kan wijzigingen doorvoeren via ${describe(list)}`,
      matches: [...list, ...unknown],
      dryRun: false,
      tooLarge: false,
    };
  }

  // 2. Every command we could not vouch for carries an affirmative -WhatIf.
  if (unknown.size > 0 && unguardedUnknown === 0) {
    return {
      mutating: false,
      because: `elk mogelijk wijzigend commando (${describe([...unknown])}) gebruikt -WhatIf, dus dit is een dry run`,
      matches: [...unknown],
      dryRun: true,
      tooLarge: false,
    };
  }

  // 3. Default-deny: something is not recognisable as read-only.
  if (unknown.size > 0) {
    const list = [...unknown];
    return {
      mutating: true,
      because: `${describe(list)} is niet herkend als lezend commando, dus dit geldt als een wijziging`,
      matches: list,
      dryRun: false,
      tooLarge: false,
    };
  }

  // 4. Everything was recognised as read-only.
  const seen = [...safeSeen];
  return {
    mutating: false,
    because:
      seen.length > 0
        ? `alleen erkende lezende commando's gevonden (${describe(seen)})`
        : "geen uitvoerbare commando's gevonden",
    matches: [],
    dryRun: false,
    tooLarge: false,
  };
}

/** Keep the prompt readable but always name concrete evidence. */
function describe(items: string[]): string {
  const shown = items.slice(0, 4).join(", ");
  return items.length > 4 ? `${shown} en ${items.length - 4} andere` : shown;
}
