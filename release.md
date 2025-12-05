# Release Instructions

## Creating a New Release

Run the release script with the desired version:

```bash
./release.sh 0.0.1
```

This will:
1. Update `package.json` with the new version
2. Commit the changes
3. Create and push a version tag
4. Trigger GitHub Actions to build binaries and create a GitHub Release
