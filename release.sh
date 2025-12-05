#!/bin/bash

# Exit on error
set -e

# Check if version is provided
if [ -z "$1" ]; then
  echo "Error: Version not provided"
  echo "Usage: ./release.sh <version>"
  echo "Example: ./release.sh 1.0.0"
  exit 1
fi

VERSION=$1

# Add 'v' prefix if not present
if [[ ! $VERSION =~ ^v ]]; then
  VERSION="v$VERSION"
fi

echo "Creating release $VERSION..."

# Update package.json version (remove 'v' prefix for package.json)
PACKAGE_VERSION=${VERSION#v}
npm version $PACKAGE_VERSION --no-git-tag-version

# Commit changes
git add package.json package-lock.json
git commit -m "Prepare release $VERSION"

# Create tag
git tag $VERSION

# Push changes and tag
git push origin main
git push origin $VERSION

echo "✓ Release $VERSION created successfully!"
echo "GitHub Actions will build and publish the release."
