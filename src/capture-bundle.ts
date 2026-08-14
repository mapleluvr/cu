import { createHash } from "node:crypto";

import {
  parseCaptureSidecarBytes,
  type CaptureSidecar,
  type RecordBinding
} from "./observation-record.js";
import {
  copyValidatedPngBytes,
  validatePngBytes,
  type ValidatedPng
} from "./png.js";

export class CaptureBundleError extends Error {}

export type ValidatedCaptureMetadata = Readonly<
  Omit<CaptureSidecar, "source" | "image"> & {
    source: Readonly<CaptureSidecar["source"]>;
    image: Readonly<CaptureSidecar["image"]>;
  }
>;

export type ValidatedCaptureBundle = Readonly<{
  capture: ValidatedCaptureMetadata;
  captureMetadataSha256: string;
}>;

export type CaptureBundleBytes = Readonly<{
  captureMetadata: Buffer;
  image: Buffer;
}>;

type CaptureBundleState = {
  captureMetadata: Buffer;
  image: ValidatedPng;
};

const bundleState = new WeakMap<ValidatedCaptureBundle, CaptureBundleState>();

function freezeCapture(capture: CaptureSidecar): ValidatedCaptureMetadata {
  return Object.freeze({
    ...capture,
    source: Object.freeze({ ...capture.source }),
    image: Object.freeze({ ...capture.image })
  });
}

export async function validateCaptureBundleBytes(
  captureMetadataInput: Buffer,
  imageInput: Buffer,
  expected: RecordBinding
): Promise<ValidatedCaptureBundle> {
  try {
    if (!Buffer.isBuffer(captureMetadataInput) || !Buffer.isBuffer(imageInput)) {
      throw new CaptureBundleError();
    }
    const captureMetadata = Buffer.from(captureMetadataInput);
    const capture = freezeCapture(parseCaptureSidecarBytes(captureMetadata, expected));
    const image = await validatePngBytes(imageInput);
    if (
      capture.image.sha256 !== image.sha256 ||
      capture.image.byteLength !== image.byteLength ||
      capture.image.width !== image.width ||
      capture.image.height !== image.height
    ) {
      throw new CaptureBundleError();
    }
    const bundle = Object.freeze({
      capture,
      captureMetadataSha256: createHash("sha256").update(captureMetadata).digest("hex")
    });
    bundleState.set(bundle, { captureMetadata, image });
    return bundle;
  } catch {
    throw new CaptureBundleError();
  }
}

export function copyValidatedCaptureBundleBytes(
  bundle: ValidatedCaptureBundle
): CaptureBundleBytes {
  const state = bundleState.get(bundle);
  if (state === undefined) {
    throw new CaptureBundleError();
  }
  return {
    captureMetadata: Buffer.from(state.captureMetadata),
    image: copyValidatedPngBytes(state.image)
  };
}
