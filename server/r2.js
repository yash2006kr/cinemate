import {
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const uploadExpirySeconds = 60 * 60;

export function hasR2Config() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET &&
    process.env.R2_PUBLIC_URL
  );
}

function r2Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

export function publicR2Url(key) {
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

export async function createR2Upload({ key, contentType }) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    ContentType: contentType || "application/octet-stream"
  });

  return {
    uploadUrl: await getSignedUrl(r2Client(), command, { expiresIn: uploadExpirySeconds }),
    mediaUrl: publicR2Url(key),
    key
  };
}

export async function deleteR2Object(key) {
  if (!hasR2Config() || !key) return;
  await r2Client().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  }));
}

export async function downloadR2Object(key, destination) {
  const response = await r2Client().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  }));
  await pipeline(response.Body, createWriteStream(destination));
}

export async function uploadR2File(key, filepath, contentType) {
  const upload = new Upload({
    client: r2Client(),
    params: {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: createReadStream(filepath),
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable"
    },
    partSize: 16 * 1024 * 1024,
    queueSize: 2
  });
  await upload.done();
  return publicR2Url(key);
}

export async function deleteR2Prefix(prefix) {
  if (!hasR2Config() || !prefix) return;
  const client = r2Client();
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    const objects = (page.Contents || []).map(({ Key }) => ({ Key }));
    if (objects.length) {
      await client.send(new DeleteObjectsCommand({
        Bucket: process.env.R2_BUCKET,
        Delete: { Objects: objects, Quiet: true }
      }));
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}
