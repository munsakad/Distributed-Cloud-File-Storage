output "s3_bucket_name" {
  value = aws_s3_bucket.chunks.bucket
}

output "s3_bucket_arn" {
  value = aws_s3_bucket.chunks.arn
}

output "backend_iam_policy_arn" {
  value = aws_iam_policy.backend_s3_access.arn
}

output "ecr_backend_repo_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "ecr_gateway_repo_url" {
  value = aws_ecr_repository.gateway.repository_url
}
