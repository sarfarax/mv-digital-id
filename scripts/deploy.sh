#!/usr/bin/env bash
#
# Publish the static site to S3 and refresh CloudFront.
#
#   S3_BUCKET=... CLOUDFRONT_DISTRIBUTION_ID=... scripts/deploy.sh
#
# Used by .github/workflows/deploy.yml and safe to run by hand with AWS
# credentials that can write the bucket. Only files the pages load are
# uploaded; tools/, docs and repo metadata stay out of the bucket.

set -euo pipefail

: "${S3_BUCKET:?Set S3_BUCKET to the bucket name from the CloudFormation outputs}"
: "${CLOUDFRONT_DISTRIBUTION_ID:?Set CLOUDFRONT_DISTRIBUTION_ID from the CloudFormation outputs}"

cd "$(dirname "$0")/.."

# File names never change between versions, so pages and code are cached
# briefly and the invalidation below makes a deploy visible immediately.
aws s3 sync . "s3://${S3_BUCKET}" --delete --no-progress \
	--exclude "*" \
	--include "*.html" \
	--include "css/*" \
	--include "js/*" \
	--include "LICENSE" \
	--exclude "js/lib/README.md" \
	--cache-control "public, max-age=300"

# Face models: about 7 MB, vendored and rarely touched, so cached for a month.
aws s3 sync models "s3://${S3_BUCKET}/models" --delete --no-progress \
	--cache-control "public, max-age=2592000"

# Sample cards and portraits. The .rgba fixtures are only read by tools/.
aws s3 sync samples "s3://${S3_BUCKET}/samples" --delete --no-progress \
	--exclude "*.rgba" \
	--cache-control "public, max-age=86400"

aws cloudfront create-invalidation \
	--distribution-id "${CLOUDFRONT_DISTRIBUTION_ID}" \
	--paths "/*" \
	--query "Invalidation.Id" --output text
