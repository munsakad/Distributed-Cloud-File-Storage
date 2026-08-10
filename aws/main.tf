terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Third replica target for the application's own chunk-level replication
# (see backend/src/services/replication/s3Replica.ts). Bucket versioning is
# also turned on as a second, storage-layer safety net independent of the
# app's own version-control system.
resource "aws_s3_bucket" "chunks" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_versioning" "chunks" {
  bucket = aws_s3_bucket.chunks.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "chunks" {
  bucket = aws_s3_bucket.chunks.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "chunks" {
  bucket                  = aws_s3_bucket.chunks.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# IAM policy the backend pod needs (attach to an IRSA role on EKS, or to an
# IAM user for local/dev use — IRSA is strongly preferred).
resource "aws_iam_policy" "backend_s3_access" {
  name        = "${var.project_name}-backend-s3-access"
  description = "Allows the mini-dropbox backend to read/write/delete chunk objects"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.chunks.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.chunks.arn
      }
    ]
  })
}

# Container registries for the buildpacks-built images (no Dockerfile —
# see scripts/build-backend.sh and scripts/build-gateway.sh).
resource "aws_ecr_repository" "backend" {
  name                 = "${var.project_name}-backend"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "gateway" {
  name                 = "${var.project_name}-gateway"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}
