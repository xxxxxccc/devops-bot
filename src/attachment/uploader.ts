/**
 * AttachmentUploader — pluggable interface for uploading attachments
 * to an external storage backend and obtaining a public URL.
 *
 * Providers implement this interface; the factory selects one based
 * on the ATTACHMENT_STORAGE environment variable.
 */

export interface UploadFile {
  path: string
  filename: string
  mimetype: string
  /** Target project ID for building storage paths (e.g. "nextjs-template"). Defaults to "_general". */
  projectId?: string
}

export interface AttachmentUploader {
  /** Upload a single file. Returns the public URL, or undefined on failure. */
  upload(file: UploadFile): Promise<string | undefined>

  /**
   * Upload multiple files as a batch (e.g. single Git commit).
   * Returns an array of URLs aligned with the input order; undefined for failures.
   */
  uploadBatch(files: UploadFile[]): Promise<Array<string | undefined>>
}

/**
 * Base class providing a default `uploadBatch` that loops over `upload`.
 * Providers that support native batching (e.g. github-repo via Git Tree API)
 * should override `uploadBatch`.
 */
export abstract class BaseUploader implements AttachmentUploader {
  abstract upload(file: UploadFile): Promise<string | undefined>

  async uploadBatch(files: UploadFile[]): Promise<Array<string | undefined>> {
    return Promise.all(files.map((f) => this.upload(f)))
  }
}
