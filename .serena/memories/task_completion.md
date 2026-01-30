# Task Completion Checklist

## When Adding a New Tool

1. Create `bin/claude-{name}.mjs` with shebang and JSDoc
2. Add entry to `package.json` under `"bin"`
3. Update `README.md` with usage documentation
4. Test locally with `node bin/claude-{name}.mjs`
5. Run `npm link` to update global installation

## When Modifying Existing Tools

1. Test changes locally with `node bin/<tool>.mjs`
2. Verify argument parsing works correctly
3. Check output formatting is consistent

## No Automated Tests/Linting
This project currently has no:
- Test framework
- Linter configuration
- Formatter configuration
- CI/CD pipeline

Manual testing is required.
