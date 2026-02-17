# CLI Tool Auto-Discovery Research

**For: Agent Monitor project**
**Date: 2026-02-17**
**Scope: Practical implementations of automatic CLI tool discovery, classification, and understanding**

---

## Table of Contents

1. [PATH Scanning Implementations](#1-path-scanning-implementations)
2. [Shell Completion Files as Schema Sources](#2-shell-completion-files-as-schema-sources)
3. [Fig.io Autocomplete Specs Analysis](#3-figio-autocomplete-specs-analysis)
4. [argc-completions: 1000+ CLI Definitions](#4-argc-completions-1000-cli-definitions)
5. [LLM Prompt Patterns for --help Parsing](#5-llm-prompt-patterns-for---help-parsing)
6. [Binary Classification Heuristics](#6-binary-classification-heuristics)
7. [Package Manager Databases as Metadata Sources](#7-package-manager-databases-as-metadata-sources)
8. [Existing Auto-Discovery Projects and Prior Art](#8-existing-auto-discovery-projects-and-prior-art)
9. [Recommended Pipeline for Agent Monitor](#9-recommended-pipeline-for-agent-monitor)
10. [Sources](#10-sources)

---

## 1. PATH Scanning Implementations

### How `which` Works

The `which` command searches through directories listed in the `PATH` environment variable, checking each directory for an executable matching the given name. On Linux, it checks the executable bit (`x`). On Windows, it checks `PATHEXT` extensions (`.exe`, `.cmd`, `.bat`, etc.).

### Node.js: Scan All Executables in PATH

```javascript
import { readdir, stat, access, constants } from 'node:fs/promises';
import path from 'node:path';

/**
 * Discover all executable binaries in PATH.
 * Returns Map<binaryName, absolutePath>
 */
async function scanPATH() {
  const envPath = process.env.PATH || '';
  const pathDirs = envPath
    .replace(/["]+/g, '')
    .split(path.delimiter)
    .filter(Boolean);

  // Deduplicate PATH dirs (common on many systems)
  const uniqueDirs = [...new Set(pathDirs)];

  const binaries = new Map(); // name -> first-found absolute path

  for (const dir of uniqueDirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (binaries.has(entry.name)) continue; // first match wins (like which)
        const fullPath = path.join(dir, entry.name);
        try {
          // Check if it's a file and executable
          const stats = await stat(fullPath);
          if (stats.isFile()) {
            await access(fullPath, constants.X_OK);
            binaries.set(entry.name, fullPath);
          }
        } catch {
          // Not executable or stat failed -- skip
        }
      }
    } catch {
      // Directory doesn't exist or not readable -- skip
    }
  }

  return binaries;
}
```

### Node.js: Find a Single Executable (which replacement)

```javascript
import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Find an executable in PATH (cross-platform).
 * Equivalent to `which <exe>`.
 * @param {string} exe - executable name (without extension on Windows)
 * @returns {Promise<string|null>} absolute path if found
 */
async function findExecutable(exe) {
  const envPath = process.env.PATH || '';
  const envExt = process.env.PATHEXT || '';
  const pathDirs = envPath
    .replace(/["]+/g, '')
    .split(path.delimiter)
    .filter(Boolean);
  const extensions = envExt ? envExt.split(';') : [''];

  const candidates = pathDirs.flatMap((d) =>
    extensions.map((ext) => path.join(d, exe + ext))
  );

  try {
    return await Promise.any(
      candidates.map(async (filePath) => {
        if ((await stat(filePath)).isFile()) return filePath;
        throw new Error('Not a file');
      })
    );
  } catch {
    return null;
  }
}
```

**Source**: [Checking if an executable exists in PATH using Node.js](https://abdus.dev/posts/checking-executable-exists-in-path-using-node/)

### Existing npm Packages

| Package | Purpose | Notes |
|---------|---------|-------|
| `which` (npm) | Find executables in PATH | Most popular, cross-platform |
| `hasbin` | Check if binary exists in PATH | Boolean check, by Springer Nature |
| `real-executable-path` | Resolve executable + follow symlinks | Returns canonical path |
| `execa` | Process execution for humans | Can run `which` cross-platform |

### Key Considerations for PATH Scanning

- **Deduplication**: PATH often contains duplicate entries (e.g., `/home/user/.local/bin` appears 4+ times on this system)
- **Symlinks**: Many binaries are symlinks (e.g., `vim -> /etc/alternatives/vim`). Resolve with `fs.realpath()`
- **Performance**: `/usr/bin` alone can have 1,200+ entries. Scan is I/O bound -- batch with `readdir()`, don't check each file individually
- **Platform**: `fs.constants.X_OK` doesn't work on Windows; use `PATHEXT` extensions instead
- **Scale on this system**: ~1,266 binaries in `/usr/bin`, ~439 in `/usr/sbin`, ~81 in `~/.local/bin`

---

## 2. Shell Completion Files as Schema Sources

### Bash Completion Files

**Location**: `/usr/share/bash-completion/completions/`

On this system there are **912 completion scripts** -- one per command. These are loaded on-demand when the user first TABs a command.

**How it works**: When TAB is pressed and no completion is loaded, bash looks for a file named after the command in the completions directory. The `__load_completion` function searches:
1. `~/.local/share/bash-completion/completions/`
2. `/usr/local/share/bash-completion/completions/`
3. `/usr/share/bash-completion/completions/`

**What's inside a completion script** (example from `apt`):

```bash
_apt()
{
    local GENERIC_APT_GET_OPTIONS='
        -d --download-only
        -y --assume-yes
        --assume-no
        -u --show-upgraded
        -m --ignore-missing
        -t --target-release
        --download
        --fix-missing
        ...
    '

    local COMMANDS=(
        "list" "search" "show" "showsrc"
        "install" "reinstall" "remove" "purge" "autoremove"
        "update" "upgrade" "full-upgrade" "dist-upgrade"
        "edit-sources" "help" "source" "build-dep"
        "clean" "autoclean" "download" "changelog"
        "depends" "rdepends" "policy"
    )
    ...
}
```

**Parsing strategy**: Completion scripts embed command structure in extractable patterns:
- `COMMANDS=(...)` or `local commands="..."` -- subcommands
- `COMPREPLY=( $( compgen -W '...' ))` -- option lists
- `case` statements mapping subcommands to their options
- Strings containing `--long-options` and `-s` short options

**Parsing difficulty**: Medium. The scripts are shell code, not data. You'd need regex or AST parsing to extract the embedded schemas. However, the patterns are highly consistent across scripts.

### Zsh Completion Functions

**Location**: `/usr/share/zsh/functions/Completion/` (not present on this system, but standard on systems with zsh)

Zsh completions use the `_arguments` function which is essentially a **declarative CLI schema**:

```zsh
_arguments \
  '-f[input file]:filename:_files' \
  '-s[sort output]' \
  '-v[verbose mode]' \
  '1:first arg:_net_interfaces' \
  '::optional arg:_files'
```

**Schema format decoded**:
- `'-f[description]:message:action'` -- option with argument
- `'-s[description]'` -- boolean flag
- `'N:message:action'` -- positional argument at position N
- `'::message:action'` -- optional argument (double colon)
- Actions: `_files`, `_users`, `_net_interfaces`, `(item1 item2)` (static list), `->state` (branching)

**This is the richest schema source** because zsh completions are essentially declarative grammars. The `_arguments` format directly encodes:
- All options with descriptions
- Whether options take arguments
- Positional argument positions and types
- Optional vs required arguments

**Parsing strategy**: Parse `_arguments` calls with regex. The format is well-documented and consistent across the 800+ zsh-completions in the [zsh-users/zsh-completions](https://github.com/zsh-users/zsh-completions) repository.

### Using `compgen` for Discovery

```bash
# List all available commands
compgen -c

# List all aliases
compgen -a

# List all builtins
compgen -b

# List all functions
compgen -A function
```

**Source**: [bash-completion GitHub](https://github.com/scop/bash-completion)

---

## 3. Fig.io Autocomplete Specs Analysis

### Overview

The [withfig/autocomplete](https://github.com/withfig/autocomplete) repository is the single best existing source of structured CLI tool definitions. It contains **TypeScript specs for 500+ CLI tools**, maintained by 468+ contributors.

Now part of Amazon Q Developer CLI.

### Spec Format

Every CLI tool is defined as a TypeScript object conforming to the `Fig.Spec` interface:

```typescript
const completionSpec: Fig.Spec = {
  name: "git",
  description: "the stupid content tracker",
  subcommands: [
    {
      name: "checkout",
      description: "Switch branches or restore working tree files",
      args: {
        name: "branch",
        generators: branchGenerator,
        isOptional: true,
      },
      options: [
        {
          name: ["-b"],
          description: "Create and checkout a new branch",
          args: { name: "branch" },
        },
      ],
    },
    {
      name: "add",
      description: "Stage files to commit",
      args: { template: "filepaths" },
    },
  ],
  options: [
    {
      name: ["--version"],
      description: "View your current git version",
    },
  ],
};

export default completionSpec;
```

### Key Schema Objects

| Object | Properties | Purpose |
|--------|-----------|---------|
| **Spec** (root) | `name`, `description`, `subcommands[]`, `options[]`, `args` | Top-level CLI tool definition |
| **Subcommand** | `name`, `description`, `subcommands[]`, `options[]`, `args` | Nested command (recursive) |
| **Option** | `name[]`, `description`, `args?`, `isRequired?`, `isPersistent?` | Flags like `--verbose`, `-v` |
| **Arg** | `name`, `description`, `template?`, `generators?`, `isOptional?`, `isVariadic?` | Positional arguments |
| **Generator** | `script`, `postProcess()`, `trigger`, `custom()` | Dynamic value completion |

### Generator Pattern (Dynamic Values)

```typescript
const branches: Fig.Generator = {
  script: "git branch --no-color",
  postProcess: (output) => {
    return output.split("\n").map((branch) => ({
      name: branch.replace("*", "").trim(),
      description: "branch",
    }));
  },
};
```

### How to Use Fig Specs for Agent Monitor

1. **Clone the repo**: `git clone https://github.com/withfig/autocomplete`
2. **Parse the TypeScript files** in `src/` -- they compile to plain JS objects
3. **Extract the schema** -- each file exports a `Fig.Spec` object
4. **Build a lookup table**: `tool name -> {subcommands, options, args}`

The specs are pure data (no runtime dependencies on Fig), so they can be imported directly into any Node.js project.

**Caveat**: Fig specs cover popular tools but not everything. They're best as a "known tools" database, supplemented by dynamic discovery for unknown tools.

---

## 4. argc-completions: 1000+ CLI Definitions

### Overview

The [sigoden/argc-completions](https://github.com/sigoden/argc-completions) project provides cross-shell completions for **1000+ commands** across bash, zsh, fish, PowerShell, and nushell.

### Key Innovation

argc-completions can **automatically generate completion scripts from help text or man pages**. This is exactly the approach Agent Monitor needs.

### How It Works

1. Uses the `argc` framework (Rust-based Bash CLI framework)
2. Defines completions using comment-based decorators in Bash scripts
3. Can auto-generate from `--help` output and man pages
4. Stores completions in a structured `completions/` directory

### Integration Potential

- Use as a pre-built database of 1000+ tool schemas
- Study their auto-generation approach for dynamic discovery
- The completion definitions encode subcommands, options, and argument types

**Source**: [argc-completions GitHub](https://github.com/sigoden/argc-completions)

---

## 5. LLM Prompt Patterns for --help Parsing

### The Problem

`--help` output is semi-structured text with no standard format. Examples:
- GNU tools: structured with sections (SYNOPSIS, OPTIONS, DESCRIPTION)
- Modern tools: may use subcommand format (git, docker)
- Minimal tools: just a usage line
- Some tools: no `--help` at all (return error code)

### Recommended LLM Prompt for --help Parsing

```
System Prompt:
You are a CLI tool analyzer. Given the --help output of a command-line tool,
extract its interface into structured JSON.

Return ONLY valid JSON matching this schema:
{
  "name": "string - the tool name",
  "description": "string - one-line description of what the tool does",
  "category": "string - one of: version-control, container, cloud, editor,
               shell-util, network, file-util, package-manager, build-tool,
               database, monitoring, ai-agent, other",
  "isInteractive": boolean,
  "subcommands": [
    {
      "name": "string",
      "description": "string",
      "aliases": ["string"]
    }
  ],
  "options": [
    {
      "flags": ["--long-flag", "-s"],
      "description": "string",
      "takesValue": boolean,
      "valueHint": "string or null",
      "isRequired": boolean
    }
  ],
  "positionalArgs": [
    {
      "name": "string",
      "description": "string",
      "isOptional": boolean,
      "isVariadic": boolean
    }
  ],
  "examples": ["string - example usage lines"]
}

Rules:
- If the tool has subcommands, list them. Don't recursively parse subcommand help.
- Flags array should include all aliases (e.g., ["-v", "--verbose"])
- Set isInteractive to true only if the tool runs a TUI/REPL (vim, python, node)
- Omit empty arrays
- If you can't determine a field, omit it rather than guessing
```

### Two-Phase Parsing Strategy

**Phase 1: Fast heuristic parse** (no LLM, regex-based)

```javascript
function quickParseHelp(helpText) {
  const result = { options: [], subcommands: [] };

  // Extract options: lines starting with whitespace then -
  const optionRegex = /^\s+(--?\S+)(?:[,\s]+(--?\S+))?(?:\s+(\S+))?\s{2,}(.+)$/gm;
  let match;
  while ((match = optionRegex.exec(helpText)) !== null) {
    result.options.push({
      flags: [match[1], match[2]].filter(Boolean),
      valueHint: match[3] || null,
      description: match[4].trim(),
    });
  }

  // Extract subcommands: indented word followed by description
  const cmdRegex = /^\s{2,4}(\w[\w-]*)\s{2,}(.+)$/gm;
  while ((match = cmdRegex.exec(helpText)) !== null) {
    // Filter out false positives (options that look like commands)
    if (!match[1].startsWith('-')) {
      result.subcommands.push({
        name: match[1],
        description: match[2].trim(),
      });
    }
  }

  return result;
}
```

**Phase 2: LLM refinement** (for complex/ambiguous cases)

Only invoke the LLM when:
- Phase 1 finds 0 options and 0 subcommands
- The help text has unusual formatting
- The tool is a priority target (in a user's favorites list)

### Structured Output with LLMs

Use structured output / function calling to guarantee JSON:

```javascript
// With Anthropic Claude API
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 2000,
  system: SYSTEM_PROMPT_ABOVE,
  messages: [{ role: "user", content: helpOutput }],
  // Use tool_choice to force structured output
  tools: [{
    name: "parse_cli_tool",
    description: "Parse CLI help text into structured format",
    input_schema: CLI_SCHEMA // the JSON schema above
  }],
  tool_choice: { type: "tool", name: "parse_cli_tool" }
});
```

### Google TextFSM: Template-Based Parsing (Alternative)

[Google TextFSM](https://github.com/google/textfsm) implements template-based state machines for parsing semi-structured CLI text. Originally built for network device CLI output. Could be adapted for `--help` parsing with templates for common help formats (GNU, subcommand-style, minimal).

**Sources**:
- [LangChain structured output docs](https://python.langchain.com/docs/how_to/output_parser_structured/)
- [The guide to structured outputs](https://agenta.ai/blog/the-guide-to-structured-outputs-and-function-calling-with-llms)
- [Google TextFSM](https://github.com/google/textfsm)

---

## 6. Binary Classification Heuristics

### The Classification Problem

Given a binary name, determine:
- Is it a CLI tool, a daemon, a TUI app, or a library utility?
- Is it an AI agent?
- Is it interactive or batch-mode?

### Heuristic 1: Man Page Section Number

Man pages are organized into numbered sections that directly classify binaries:

| Section | Contains | Examples |
|---------|----------|----------|
| 1 | User commands | git, ls, grep, curl |
| 2 | System calls | open, read, write |
| 3 | Library functions | printf, malloc |
| 5 | File formats | crontab, passwd |
| 6 | Games | fortune |
| 8 | System admin / Daemons | nginx, sshd, iptables |

**Implementation**:
```javascript
import { execFile } from 'node:child_process';

async function getManSection(binaryName) {
  return new Promise((resolve) => {
    execFile('man', ['-w', binaryName], (err, stdout) => {
      if (err) return resolve(null);
      // Path like /usr/share/man/man1/git.1.gz
      const match = stdout.match(/man(\d)\//);
      resolve(match ? parseInt(match[1]) : null);
    });
  });
}

// Section 1 = CLI tool, Section 8 = daemon/admin tool
```

**On this system**: 1,696 man pages in section 1 (commands), 964 in section 8 (admin/daemons).

### Heuristic 2: systemd Service Association

If a binary is associated with a systemd service, it's likely a daemon:

```javascript
import { execFile } from 'node:child_process';

async function isSystemdService(binaryName) {
  return new Promise((resolve) => {
    execFile('systemctl', ['list-unit-files', '--type=service'],
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(stdout.toLowerCase().includes(binaryName.toLowerCase()));
      }
    );
  });
}
```

### Heuristic 3: Binary Name Patterns

| Pattern | Classification | Examples |
|---------|---------------|----------|
| Ends with `d` | Often a daemon | `sshd`, `httpd`, `containerd`, `dockerd` |
| Starts with `lib` | Library utility | `libtool` |
| Common AI names | AI agent | `claude`, `gemini`, `codex`, `aichat`, `ollama` |
| Contains `ctl` | Control interface for daemon | `systemctl`, `kubectl`, `dockerctl` |
| Standard utils | Shell utility | `ls`, `cat`, `grep`, `find`, `sort`, `awk`, `sed` |

### Heuristic 4: TTY Detection / Interactive Classification

From [clig.dev](https://clig.dev/): "The most straightforward heuristic for whether output is being read by a human is whether or not it's a TTY."

**Classification signals**:
- Tool accepts `--interactive` or `-i` flag = likely has interactive mode
- Tool has `--no-pager`, `--color=auto` = designed for terminal use
- Tool creates a TUI (ncurses, etc.) = interactive (vim, htop, tmux)
- Tool reads from stdin without args = likely a filter/pipe tool (grep, awk)
- Tool exits immediately with output = batch/non-interactive

### Heuristic 5: `file` Command Output

```bash
$ file /usr/bin/git
/usr/bin/git: ELF 64-bit LSB pie executable, x86-64...

$ file /usr/bin/vim
/usr/bin/vim: symbolic link to /etc/alternatives/vim
```

The `file` command can identify:
- Script interpreters (Python, shell, Ruby, Perl scripts)
- ELF executables vs scripts vs symlinks
- Architecture information

### Heuristic 6: Package Manager Category

```javascript
import { execFile } from 'node:child_process';

async function getPackageSection(binaryPath) {
  return new Promise((resolve) => {
    // Step 1: Find which package owns the binary
    execFile('dpkg', ['-S', binaryPath], (err, stdout) => {
      if (err) return resolve(null);
      const pkgName = stdout.split(':')[0];

      // Step 2: Get the package section from apt-cache
      execFile('apt-cache', ['show', pkgName], (err2, stdout2) => {
        if (err2) return resolve(null);
        const sectionMatch = stdout2.match(/^Section:\s*(.+)$/m);
        resolve(sectionMatch ? sectionMatch[1] : null);
      });
    });
  });
}
// Returns: "vcs" (git), "web" (curl), "admin" (systemd), etc.
```

### Combined Classification Algorithm

```javascript
function classifyBinary(info) {
  const { name, manSection, isService, helpText, packageSection } = info;

  // Definite daemon indicators
  if (isService) return 'daemon';
  if (name.endsWith('d') && manSection === 8) return 'daemon';

  // AI agent indicators
  const aiNames = ['claude', 'gemini', 'codex', 'ollama', 'aichat',
                    'grok', 'copilot'];
  if (aiNames.some(ai => name.includes(ai))) return 'ai-agent';

  // Interactive TUI indicators
  const tuiTools = ['vim', 'nvim', 'nano', 'emacs', 'htop', 'top',
                     'tmux', 'screen', 'less', 'more'];
  if (tuiTools.includes(name)) return 'interactive-tui';

  // Shell builtins and basic utils
  const shellUtils = ['ls', 'cat', 'grep', 'find', 'sort', 'awk',
                       'sed', 'tr', 'cut', 'wc', 'head', 'tail'];
  if (shellUtils.includes(name)) return 'shell-util';

  // Man section classification
  if (manSection === 1) return 'cli-tool';
  if (manSection === 8) return 'admin-tool';
  if (manSection === 6) return 'game';

  // Default
  return 'cli-tool';
}
```

---

## 7. Package Manager Databases as Metadata Sources

### dpkg: Binary-to-Package Mapping (Debian/Ubuntu)

```bash
# Map binary to package
$ dpkg -S /usr/bin/git
git: /usr/bin/git

$ dpkg -S /usr/bin/curl
curl: /usr/bin/curl

$ dpkg -S /usr/bin/docker
docker-ce-cli: /usr/bin/docker
```

**Node.js implementation**:
```javascript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

async function binaryToPackage(binaryPath) {
  const { stdout } = await execFileAsync('dpkg', ['-S', binaryPath]);
  return stdout.split(':')[0]; // package name
}
```

### apt-cache: Package Metadata

```bash
$ apt-cache show git
Package: git
Section: vcs
Description-en: fast, scalable, distributed revision control system
Depends: libc6, libcurl3-gnutls, perl, git-man
Suggests: git-doc, git-email, git-gui, gitk
```

Useful fields: `Section` (category), `Description`, `Depends` (related tools), `Suggests`.

### apt-file: Uninstalled Package Search

```bash
# Find which package provides a binary (even if not installed)
$ apt-file search /usr/bin/rg
ripgrep: /usr/bin/rg
```

### Homebrew JSON API (macOS)

```bash
# Local query
$ brew info --json=v1 git | jq '.[0] | {name, desc, homepage}'
{
  "name": "git",
  "desc": "Distributed revision control system",
  "homepage": "https://git-scm.com"
}

# Remote API (no Homebrew needed)
# GET https://formulae.brew.sh/api/formula/git.json
```

**Source**: [Querying Brew documentation](https://docs.brew.sh/Querying-Brew)

### npm Global Packages

```bash
# List globally installed CLI tools
$ npm list -g --depth=0 --json
```

The `bin` field in `package.json` maps command names to scripts:
```json
{
  "bin": {
    "cowsay": "./cli.js",
    "cowthink": "./cli.js"
  }
}
```

### command-not-found: Ubuntu's Binary Database

Ubuntu's `command-not-found` package maintains a **SQLite database** mapping command names to packages:

- **Location**: `/var/lib/command-not-found/commands.db`
- **Built by**: `/usr/lib/cnf-update-db` (Python script)
- **Updated via**: APT post-invoke hook in `/etc/apt/apt.conf.d/50command-not-found`
- **Data sources**:
  - `Contents-$arch` files from package repositories
  - Manual override files
  - `update-alternatives` scanning from postinst scripts

This database contains essentially every command available in Ubuntu's repositories, whether installed or not.

**Source**: [CommandNotFoundMagic - Ubuntu Wiki](https://wiki.ubuntu.com/CommandNotFoundMagic)

---

## 8. Existing Auto-Discovery Projects and Prior Art

### Fig.io / Amazon Q Developer CLI

- **Approach**: Manually curated TypeScript specs for 500+ tools
- **Repo**: [withfig/autocomplete](https://github.com/withfig/autocomplete) (4,897 commits, 468+ contributors)
- **Strength**: Highest-quality specs with generators for dynamic values
- **Weakness**: Manual curation doesn't scale; only covers popular tools

### Warp Terminal

- **Approach**: Maintains completion specs with fuzzy search, supports shell history-based suggestions
- **Key feature**: Works across SSH sessions; understands aliases
- **Completion engine**: Proprietary, but uses similar structured specs
- **Source**: [Warp completions docs](https://docs.warp.dev/terminal/command-completions/completions)

### argc-completions

- **Approach**: Auto-generates completions from help text and man pages
- **Coverage**: 1,000+ commands across 5 shells
- **Repo**: [sigoden/argc-completions](https://github.com/sigoden/argc-completions)
- **Key insight**: Uses `argc` framework's comment-decorator DSL

### zsh-completions

- **Approach**: Community-curated zsh completion functions
- **Repo**: [zsh-users/zsh-completions](https://github.com/zsh-users/zsh-completions)
- **Format**: `_arguments` declarations that serve as declarative CLI schemas

### bash-completion

- **Approach**: Official programmable completion for bash
- **Repo**: [scop/bash-completion](https://github.com/scop/bash-completion)
- **Coverage**: 912 completion scripts on this system alone

### Google TextFSM

- **Approach**: Template-based state machine for parsing semi-structured CLI text
- **Repo**: [google/textfsm](https://github.com/google/textfsm)
- **Originally for**: Network device CLI output, but applicable to any CLI parsing

### MCP (Model Context Protocol) CLI

- **Approach**: Dynamic tool discovery protocol for AI agents
- **Key idea**: Agents discover tools on-demand, query their schemas, and invoke them
- **Commands**: `mcp-cli info` (list servers), `mcp-cli info <server> <tool>` (get schema)
- **Relevance**: The protocol Agent Monitor should emit is similar to MCP's tool schema format
- **Source**: [MCP CLI intro](https://www.philschmid.de/mcp-cli)

---

## 9. Recommended Pipeline for Agent Monitor

### Architecture: Multi-Source Discovery Pipeline

```
+------------------------------------------------------------------+
|                Agent Monitor Discovery Pipeline                   |
+----------+----------+----------+----------+----------+-----------+
|  Stage 1 |  Stage 2 |  Stage 3 |  Stage 4 |  Stage 5 |  Stage 6 |
|  SCAN    |  IDENTIFY|  CLASSIFY|  SCHEMA  |  ENRICH  |  INDEX   |
|          |          |          |          |          |           |
| PATH     | dpkg -S  | man sect | Fig specs| --help   | Emit     |
| dirs     | apt-cache| systemd  | bash-comp| LLM parse| tool     |
|          | npm list | name pat | zsh-comp | man page | registry |
|          | file cmd | TTY heur | argc-comp|          |           |
+----------+----------+----------+----------+----------+-----------+
```

### Stage 1: SCAN -- Find All Binaries

```javascript
// Scan PATH, deduplicate, resolve symlinks
const binaries = await scanPATH();
// Result: Map<name, { path, realPath, isSymlink }>
// Expected: ~1,500-2,000 entries on a typical system
```

### Stage 2: IDENTIFY -- Map Binary to Package/Source

```javascript
async function identifyBinary(name, binaryPath) {
  const info = { name, path: binaryPath };

  // Try dpkg first (fast, local)
  info.package = await binaryToPackage(binaryPath).catch(() => null);

  // Get package metadata if available
  if (info.package) {
    info.metadata = await getPackageMetadata(info.package);
    info.description = info.metadata?.description;
    info.section = info.metadata?.section;
  }

  // Check file type
  info.fileType = await getFileType(binaryPath); // ELF, script, symlink

  return info;
}
```

### Stage 3: CLASSIFY -- Determine Tool Type

```javascript
async function classifyTool(info) {
  info.manSection = await getManSection(info.name);
  info.isService = await isSystemdService(info.name);
  info.toolType = classifyBinary(info); // See section 6
  return info;
}
```

### Stage 4: SCHEMA -- Get Tool Interface (Layered Strategy)

```javascript
async function getToolSchema(toolName) {
  // Layer 1: Check pre-built databases (fast, free)
  let schema = await checkFigSpecs(toolName);
  if (schema) return { source: 'fig', ...schema };

  schema = await checkArgcCompletions(toolName);
  if (schema) return { source: 'argc', ...schema };

  // Layer 2: Parse local completion files (fast, free)
  schema = await parseBashCompletion(toolName);
  if (schema) return { source: 'bash-completion', ...schema };

  schema = await parseZshCompletion(toolName);
  if (schema) return { source: 'zsh-completion', ...schema };

  // Layer 3: Run --help and parse with regex (fast, free)
  const helpText = await getHelpText(toolName);
  schema = quickParseHelp(helpText);
  if (schema.options.length > 0 || schema.subcommands.length > 0) {
    return { source: 'help-regex', ...schema };
  }

  // Layer 4: LLM parsing (slow, costs tokens -- use sparingly)
  if (helpText) {
    schema = await llmParseHelp(toolName, helpText);
    return { source: 'help-llm', ...schema };
  }

  return { source: 'unknown', name: toolName };
}
```

### Stage 5: ENRICH -- Add Contextual Metadata

```javascript
async function enrichTool(tool) {
  // Popularity signal: is it in user's shell history?
  tool.usageCount = await countInHistory(tool.name);

  // Alias detection
  tool.aliases = await findAliases(tool.name);

  // Version detection
  tool.version = await getVersion(tool.name);

  // Related tools (from package Suggests/Recommends)
  tool.relatedTools = tool.metadata?.suggests || [];

  return tool;
}
```

### Stage 6: INDEX -- Build Searchable Registry

```javascript
const registry = {
  tools: discoveredTools,
  byCategory: groupBy(discoveredTools, 'toolType'),
  byPackageSection: groupBy(discoveredTools, 'section'),
  aiAgents: discoveredTools.filter(t => t.toolType === 'ai-agent'),
  withSchemas: discoveredTools.filter(t => t.source !== 'unknown'),
  timestamp: new Date().toISOString(),
};
```

### Getting --help Output Safely

```javascript
import { execFile } from 'node:child_process';

async function getHelpText(toolName) {
  // Try --help first, then -h, then no args
  for (const args of [['--help'], ['-h'], []]) {
    try {
      const result = await new Promise((resolve, reject) => {
        execFile(toolName, args, {
          timeout: 5000,         // Kill after 5 seconds
          maxBuffer: 1024 * 100, // 100KB max output
          env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        }, (err, stdout, stderr) => {
          // Many tools write help to stderr
          const output = stdout || stderr;
          if (output && output.length > 20) resolve(output);
          else reject(new Error('No useful output'));
        });
      });
      return result;
    } catch {
      continue;
    }
  }
  return null;
}
```

**Critical safety note**: Set `timeout` to prevent hanging on interactive tools (vim, python, node). Set `TERM=dumb` and `NO_COLOR=1` to prevent escape sequences. Never pass user input to `execFile` arguments. Always use `execFile` (not `exec`) to avoid shell injection.

### Performance Budget

| Stage | Time per tool | Total (1500 tools) |
|-------|--------------|-------------------|
| Scan PATH | - | ~200ms total |
| dpkg -S | ~5ms | ~7.5s |
| man section | ~3ms | ~4.5s |
| systemd check | ~5ms | ~7.5s |
| Fig spec lookup | <1ms | ~1.5s |
| bash-completion parse | ~2ms | ~3s |
| --help execution | ~100ms | ~150s (if all) |
| LLM parse | ~2s | Only for priority tools |

**Recommendation**: Run stages 1-3 for all tools (~20s total). Run stage 4 only for tools the user actually uses (check shell history) or on-demand when a tool is selected.

### Output Format

Emit tool schemas in a format compatible with MCP tool definitions:

```typescript
interface DiscoveredTool {
  name: string;
  path: string;
  description: string;
  version?: string;
  toolType: 'cli-tool' | 'daemon' | 'ai-agent' | 'interactive-tui'
           | 'shell-util' | 'admin-tool';
  source: 'fig' | 'argc' | 'bash-completion' | 'zsh-completion'
         | 'help-regex' | 'help-llm' | 'unknown';
  package?: string;
  section?: string; // apt section: vcs, web, admin, etc.
  schema?: {
    subcommands?: Array<{
      name: string;
      description: string;
      aliases?: string[];
    }>;
    options?: Array<{
      flags: string[];
      description: string;
      takesValue: boolean;
      valueHint?: string;
    }>;
    positionalArgs?: Array<{
      name: string;
      description: string;
      isOptional: boolean;
    }>;
  };
  usageCount?: number;
  aliases?: string[];
}
```

---

## 10. Sources

### PATH Scanning and Binary Discovery
- [Checking executable in PATH - Node.js](https://abdus.dev/posts/checking-executable-exists-in-path-using-node/)
- [Node.js fs API documentation](https://nodejs.org/api/fs.html)
- [hasbin - npm](https://github.com/springernature/hasbin)
- [Cross-platform Node.js guide](https://github.com/ehmicky/cross-platform-node-guide/blob/main/docs/4_terminal/package_binaries.md)

### Shell Completions
- [bash-completion - GitHub](https://github.com/scop/bash-completion)
- [zsh-completions - GitHub](https://github.com/zsh-users/zsh-completions)
- [zsh-completions howto](https://github.com/zsh-users/zsh-completions/blob/master/zsh-completions-howto.org)
- [zsh completion system docs](https://zsh.sourceforge.io/Doc/Release/Completion-System.html)
- [Click shell completion](https://click.palletsprojects.com/en/stable/shell-completion/)

### Fig.io / Amazon Q Autocomplete
- [withfig/autocomplete - GitHub](https://github.com/withfig/autocomplete)
- [Fig autocomplete docs](https://fig.gitbook.io/fig/autocomplete)
- [Building first spec](https://fig.io/docs/guides/building-first-spec)
- [withfig/autocomplete-tools - GitHub](https://github.com/withfig/autocomplete-tools)

### argc-completions
- [sigoden/argc - GitHub](https://github.com/sigoden/argc)
- [sigoden/argc-completions - GitHub](https://github.com/sigoden/argc-completions)

### LLM Structured Output
- [LangChain structured output docs](https://python.langchain.com/docs/how_to/output_parser_structured/)
- [The guide to structured outputs](https://agenta.ai/blog/the-guide-to-structured-outputs-and-function-calling-with-llms)
- [strictjson - GitHub](https://github.com/tanchongmin/strictjson)
- [Google TextFSM - GitHub](https://github.com/google/textfsm)
- [llmparser - GitHub](https://github.com/kyang6/llmparser)

### Binary Classification
- [Command Line Interface Guidelines](https://clig.dev/)
- [Man page sections - Wikipedia](https://en.wikipedia.org/wiki/Man_page)
- [man-pages(7) conventions](https://man7.org/linux/man-pages/man7/man-pages.7.html)
- [Improving CLIs with isatty](https://blog.jez.io/cli-tty/)
- [Node.js TTY module](https://nodejs.org/api/tty.html)

### Package Manager Databases
- [dpkg binary-to-package mapping](https://www.cyberciti.biz/faq/equivalent-of-rpm-qf-command/)
- [apt-file - Debian Wiki](https://wiki.debian.org/apt-file)
- [what-provides manpage](https://manpages.ubuntu.com/manpages/focal/man1/what-provides.1.html)
- [CommandNotFoundMagic - Ubuntu Wiki](https://wiki.ubuntu.com/CommandNotFoundMagic)
- [command-not-found on Kicksecure](https://www.kicksecure.com/wiki/Command-not-found)
- [Querying Brew](https://docs.brew.sh/Querying-Brew)
- [Homebrew Formulae API](https://formulae.brew.sh/docs/api/)

### Warp and Terminal Intelligence
- [Warp completions docs](https://docs.warp.dev/terminal/command-completions/completions)
- [Warp autosuggestions](https://docs.warp.dev/terminal/command-completions/autosuggestions)

### MCP and AI Agent Tool Discovery
- [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP CLI intro](https://www.philschmid.de/mcp-cli)
- [mcp-agent - GitHub](https://github.com/lastmile-ai/mcp-agent)

### npm and Node.js CLI Discovery
- [package.json bin field](https://docs.npmjs.com/cli/v8/configuring-npm/package-json/)
- [npm list global packages](https://www.geeksforgeeks.org/node-js/how-to-get-a-list-of-globally-installed-npm-packages-in-npm/)
- [execa - GitHub](https://github.com/sindresorhus/execa)
