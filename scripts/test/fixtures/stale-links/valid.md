# Valid links fixture

This file contains links that should all pass the stale-link check.

## Relative links that exist

See [another doc](another.md) for details.

See [a subdirectory doc](subdir/nested.md) for details.

## Fragment-only links (always skipped)

See [the heading](#valid-links-fixture) below.

## External links (always skipped)

See the [GitHub docs](https://docs.github.com) for more.

Check the [npm registry](https://www.npmjs.com) too.

Send feedback to [support](mailto:support@example.com).

## Percent-encoded links that resolve

See [the other doc](another.md).

## Links inside fenced code blocks are ignored

```markdown
[broken but inside a code block](this-does-not-exist.md)
```

## Links inside inline code are ignored

The text `[broken inline](nope.md)` is fine.

## Links with titles

See [another doc](another.md "optional title") for details.
