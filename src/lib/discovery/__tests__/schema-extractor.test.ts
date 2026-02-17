import { describe, it, expect } from 'vitest';
import { quickParseHelp, type ParsedSchema } from '../schema-extractor';

const SAMPLE_HELP_WITH_OPTIONS = `Usage: mytool [OPTIONS] <input>

Options:
  -v, --verbose          Enable verbose output
  -o, --output <FILE>    Output file path
  --dry-run              Perform a trial run with no changes
  -f, --force            Force overwrite of existing files
  -n, --count NUM        Number of iterations

Commands:
  init        Initialize a new project
  build       Build the project
  test        Run the test suite
  deploy      Deploy to production
`;

const SAMPLE_HELP_OPTIONS_ONLY = `Usage: formatter [OPTIONS] <file>

Options:
  -i, --indent <SPACES>  Number of spaces for indentation
  --no-color             Disable colored output
  -q, --quiet            Suppress non-error messages
`;

const SAMPLE_HELP_SUBCOMMANDS_ONLY = `Usage: apptool <command> [options]

Commands:
  start       Start the application server
  stop        Stop the application server
  restart     Restart the application server
  status      Show application status
`;

const SAMPLE_HELP_NO_STRUCTURE = `This is a simple tool that processes files.
Run it with a filename argument.
See the manual for more details.
`;

describe('quickParseHelp', () => {
  it('parses options with short/long flags from help text', () => {
    const result: ParsedSchema = quickParseHelp(SAMPLE_HELP_WITH_OPTIONS);
    expect(result.options.length).toBeGreaterThan(0);

    // Check that we found the verbose option with both short and long flags
    const verboseOpt = result.options.find((o) => o.flags.includes('--verbose'));
    expect(verboseOpt).toBeDefined();
    expect(verboseOpt!.flags).toContain('-v');
    expect(verboseOpt!.description).toBe('Enable verbose output');

    // Check a value-taking option
    const outputOpt = result.options.find((o) => o.flags.includes('--output'));
    expect(outputOpt).toBeDefined();
    expect(outputOpt!.takesValue).toBe(true);
    expect(outputOpt!.valueHint).toBe('FILE');
  });

  it('parses subcommands from help text', () => {
    const result: ParsedSchema = quickParseHelp(SAMPLE_HELP_WITH_OPTIONS);
    expect(result.subcommands.length).toBeGreaterThan(0);

    const initCmd = result.subcommands.find((sc) => sc.name === 'init');
    expect(initCmd).toBeDefined();
    expect(initCmd!.description).toBe('Initialize a new project');

    const deployCmd = result.subcommands.find((sc) => sc.name === 'deploy');
    expect(deployCmd).toBeDefined();
    expect(deployCmd!.description).toBe('Deploy to production');
  });

  it('returns source "unknown" when no structure found', () => {
    const result: ParsedSchema = quickParseHelp(SAMPLE_HELP_NO_STRUCTURE);
    expect(result.source).toBe('unknown');
    expect(result.options).toHaveLength(0);
    expect(result.subcommands).toHaveLength(0);
  });

  it('sets source to "help-regex" when options or subcommands are found', () => {
    const resultWithOptions = quickParseHelp(SAMPLE_HELP_OPTIONS_ONLY);
    expect(resultWithOptions.source).toBe('help-regex');

    const resultWithCommands = quickParseHelp(SAMPLE_HELP_SUBCOMMANDS_ONLY);
    expect(resultWithCommands.source).toBe('help-regex');
  });

  it('does not misclassify options as subcommands', () => {
    const result: ParsedSchema = quickParseHelp(SAMPLE_HELP_OPTIONS_ONLY);

    // Should have options but no subcommands from a help text with only options
    expect(result.options.length).toBeGreaterThan(0);

    // None of the subcommands should start with a dash (that would be an option)
    for (const sc of result.subcommands) {
      expect(sc.name.startsWith('-')).toBe(false);
    }

    // Verify the flag-based entries are only in options, not subcommands
    const subcommandNames = result.subcommands.map((sc) => sc.name);
    expect(subcommandNames).not.toContain('--no-color');
    expect(subcommandNames).not.toContain('-q');
  });
});
