/**
 * Type stub for node-llama-cpp (optional peer dependency).
 *
 * When node-llama-cpp is installed, its own types take precedence.
 * When it's NOT installed, this stub prevents TS2307 errors on
 * `await import('node-llama-cpp')` dynamic imports.
 */

declare module 'node-llama-cpp' {
  export enum LlamaLogLevel {
    error = 3,
  }

  export interface LlamaModel {
    createEmbeddingContext(): Promise<LlamaEmbeddingContext>
    dispose?(): Promise<void>
  }

  export interface LlamaEmbeddingContext {
    getEmbeddingFor(text: string): Promise<{ vector: readonly number[] }>
  }

  export interface Llama {
    loadModel(options: { modelPath: string }): Promise<LlamaModel>
  }

  export function getLlama(options?: { logLevel?: LlamaLogLevel }): Promise<Llama>

  export function resolveModelFile(
    uri: string,
    directory?: string,
    options?: { cli?: boolean },
  ): Promise<string>
}
