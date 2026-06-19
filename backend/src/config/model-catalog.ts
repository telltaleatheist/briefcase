/**
 * Self-contained model catalogs (whisper + local AI / Cogito).
 *
 * Both download directly from Hugging Face at runtime, independent of the
 * GitHub binaries manifest. This is the single source of truth shared by:
 *   - ModelManagerService (Cogito GGUF management for the analysis pipeline)
 *   - ComponentManagerService (download-on-demand for the setup wizard / dock)
 *
 * Keeping the catalog here (not in the published manifest) means new sizes can
 * be added without republishing a release asset.
 */

import { ComponentArtifact, ManifestComponent } from '../components/component.types';

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const HF_BARTOWSKI = 'https://huggingface.co/bartowski';

// ---------------- Local AI (Cogito) ----------------

export interface CogitoModelDef {
  id: string;
  name: string;
  filename: string;
  url: string;
  sizeGB: number;
  /** Minimum VRAM (GPU) or RAM (CPU) needed to run the model. */
  minRAM: number;
  /** Transformer block count — used to compute partial GPU offload (-ngl). */
  layers: number;
  description: string;
}

// Using bartowski's Q4_K_M quantizations from Hugging Face.
export const COGITO_MODELS: CogitoModelDef[] = [
  {
    id: 'cogito-3b',
    name: 'Cogito 3B',
    filename: 'deepcogito_cogito-v1-preview-llama-3B-Q4_K_M.gguf',
    url: `${HF_BARTOWSKI}/deepcogito_cogito-v1-preview-llama-3B-GGUF/resolve/main/deepcogito_cogito-v1-preview-llama-3B-Q4_K_M.gguf`,
    sizeGB: 2.24,
    minRAM: 4,
    layers: 28,
    description: 'Lightweight and fast. Works on most GPUs (4GB+ VRAM) or CPU.',
  },
  {
    id: 'cogito-8b',
    name: 'Cogito 8B',
    filename: 'deepcogito_cogito-v1-preview-llama-8B-Q4_K_M.gguf',
    url: `${HF_BARTOWSKI}/deepcogito_cogito-v1-preview-llama-8B-GGUF/resolve/main/deepcogito_cogito-v1-preview-llama-8B-Q4_K_M.gguf`,
    sizeGB: 4.92,
    minRAM: 6,
    layers: 32,
    description: 'Good balance of quality and speed. Runs great on 6GB+ GPU.',
  },
  {
    id: 'cogito-14b',
    name: 'Cogito 14B',
    filename: 'deepcogito_cogito-v1-preview-qwen-14B-Q4_K_M.gguf',
    url: `${HF_BARTOWSKI}/deepcogito_cogito-v1-preview-qwen-14B-GGUF/resolve/main/deepcogito_cogito-v1-preview-qwen-14B-Q4_K_M.gguf`,
    sizeGB: 8.99,
    minRAM: 10,
    layers: 48,
    description: 'Higher quality results. Runs on 10GB+ GPU or 16GB+ RAM.',
  },
  {
    id: 'cogito-32b',
    name: 'Cogito 32B',
    filename: 'deepcogito_cogito-v1-preview-qwen-32B-Q4_K_M.gguf',
    url: `${HF_BARTOWSKI}/deepcogito_cogito-v1-preview-qwen-32B-GGUF/resolve/main/deepcogito_cogito-v1-preview-qwen-32B-Q4_K_M.gguf`,
    sizeGB: 19.85,
    minRAM: 24,
    layers: 64,
    description: 'Best quality. Needs 24GB+ GPU or a Mac with 32GB+ unified memory.',
  },
  {
    id: 'cogito-70b',
    name: 'Cogito 70B',
    filename: 'deepcogito_cogito-v1-preview-llama-70B-Q4_K_M.gguf',
    url: `${HF_BARTOWSKI}/deepcogito_cogito-v1-preview-llama-70B-GGUF/resolve/main/deepcogito_cogito-v1-preview-llama-70B-Q4_K_M.gguf`,
    sizeGB: 42.52,
    minRAM: 48,
    layers: 80,
    description: 'Maximum quality. Needs a 48GB+ GPU or a Mac with 64GB+ unified memory.',
  },
];

// ---------------- Whisper (speech-to-text) ----------------

export interface WhisperModelDef {
  /** Component id used by the download system. */
  id: string;
  /** Short model name as it appears on disk (ggml-<model>.bin). */
  model: string;
  name: string;
  description: string;
  filename: string;
  url: string;
  bytes: number;
  /** Optional — verification is skipped when absent. */
  sha256?: string;
}

export const WHISPER_MODELS: WhisperModelDef[] = [
  {
    id: 'whisper-model-tiny',
    model: 'tiny',
    name: 'Whisper Tiny (fastest)',
    description: 'Smallest and fastest, lowest accuracy. Good for quick drafts.',
    filename: 'ggml-tiny.bin',
    url: `${HF_WHISPER}/ggml-tiny.bin`,
    bytes: 77691713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  },
  {
    id: 'whisper-model-base',
    model: 'base',
    name: 'Whisper Base (recommended)',
    description: 'Balanced speed and accuracy. Recommended default.',
    filename: 'ggml-base.bin',
    url: `${HF_WHISPER}/ggml-base.bin`,
    bytes: 147951465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  },
  {
    id: 'whisper-model-small',
    model: 'small',
    name: 'Whisper Small',
    description: 'Better accuracy, slower and larger.',
    filename: 'ggml-small.bin',
    url: `${HF_WHISPER}/ggml-small.bin`,
    bytes: 487601967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  },
  {
    id: 'whisper-model-medium',
    model: 'medium',
    name: 'Whisper Medium',
    description: 'High accuracy for tougher audio. Slower, ~1.5 GB.',
    filename: 'ggml-medium.bin',
    url: `${HF_WHISPER}/ggml-medium.bin`,
    bytes: 1533763059,
  },
  {
    id: 'whisper-model-large-v3-turbo',
    model: 'large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    description: 'Near-large accuracy, much faster. ~1.5 GB.',
    filename: 'ggml-large-v3-turbo.bin',
    url: `${HF_WHISPER}/ggml-large-v3-turbo.bin`,
    bytes: 1624555275,
  },
  {
    id: 'whisper-model-large-v3',
    model: 'large-v3',
    name: 'Whisper Large v3 (most accurate)',
    description: 'Best accuracy, slowest and largest. ~3 GB.',
    filename: 'ggml-large-v3.bin',
    url: `${HF_WHISPER}/ggml-large-v3.bin`,
    bytes: 3095033483,
  },
];

// ---------------- Catalog → ManifestComponent adapters ----------------

const PLATFORMS: ComponentArtifact['platform'][] = ['darwin', 'win32', 'linux'];

/** Models are platform-agnostic single files; expand to one artifact per platform. */
function universalArtifacts(
  url: string,
  file: string,
  bytes: number,
  entry: string,
  sha256?: string,
): ComponentArtifact[] {
  return PLATFORMS.map((platform) => ({
    platform,
    arch: 'universal',
    url,
    file,
    sha256: sha256 ?? '',
    bytes,
    entry,
  }));
}

export function whisperModelComponents(): ManifestComponent[] {
  return WHISPER_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    kind: 'whisper-model',
    required: false,
    description: m.description,
    artifacts: universalArtifacts(m.url, m.filename, m.bytes, m.filename, m.sha256),
  }));
}

export function llamaModelComponents(): ManifestComponent[] {
  return COGITO_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    kind: 'llama-model',
    required: false,
    description: m.description,
    artifacts: universalArtifacts(
      m.url,
      m.filename,
      Math.round(m.sizeGB * 1024 * 1024 * 1024),
      m.filename,
    ),
  }));
}
