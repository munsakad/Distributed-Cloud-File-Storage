variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "mini-dropbox"
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket name for the replication target"
  type        = string
}
