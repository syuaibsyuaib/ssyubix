# Contributing to ssyubix

Thanks for helping improve `ssyubix`.

## Before You Start

- Open an issue for major features, protocol changes, or breaking API changes
- Keep pull requests focused and easy to review
- Update documentation when behavior or setup changes

## Repository Layout

- `src/` contains the Cloudflare Worker and Durable Object backend
- `python-src/ssyubix-2.0.0/` contains the Python MCP package

## Local Setup

Python package:

```bash
cd python-src/ssyubix-2.0.0
python -m pip install --upgrade pip
python -m pip install -e .
```

Run the Python tests:

```bash
python -m unittest discover -s tests -p "test_*.py" -v
```

Build the Python package:

```bash
python -m build
```

Validate the Cloudflare Worker bundle:

```bash
cd ../../
npx -y wrangler@4.71.0 deploy --config src/wrangler.jsonc --dry-run
```

## Pull Request Checklist

- Add or update tests when behavior changes
- Keep changes backwards compatible unless the PR is clearly marked as breaking
- Explain any protocol or deployment impact in the PR description
- Avoid committing local caches, build outputs, or credentials

## Release Notes

- PyPI publishing and Worker deployment are separate release steps
- If the default hosted Worker changes, update the package default `AGENTLINK_URL`
