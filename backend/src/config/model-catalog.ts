/**
 * Self-contained model catalogs (whisper + local AI / GGUF).
 *
 * These download directly from Hugging Face at runtime, independent of the
 * GitHub binaries manifest. This is the single source of truth shared by:
 *   - ModelManagerService (local GGUF management for the analysis pipeline)
 *   - ComponentManagerService (download-on-demand for the setup wizard / dock)
 *
 * Keeping the catalog here (not in the published manifest) means new sizes can
 * be added without republishing a release asset.
 */

import { ComponentArtifact, ManifestComponent } from '../components/component.types';
import {
  NLI_COMPONENT_ID,
  NLI_COMPONENT_NAME,
  NLI_COMPONENT_DESCRIPTION,
  NLI_INSTALL_BYTES,
} from '../common/nli-env';

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

// ---------------- Local AI (llama.cpp GGUF) ----------------

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

/**
 * Bundled llama.cpp models — intentionally EMPTY.
 *
 * Briefcase no longer ships or downloads its own GGUF weights. Local inference
 * is served entirely by Ollama, which the user manages themselves; cloud work
 * goes to Claude or OpenAI. The llama.cpp plumbing (LlamaBridge / LlamaManager /
 * ModelManagerService) is left intact and simply has nothing to offer, so the
 * 'local' provider reports unavailable and the setup wizard lists no local
 * models. Re-populating this array is all that's needed to revive it.
 */
export const COGITO_MODELS: CogitoModelDef[] = [];

// ---------------- Scorer (logit decision engine, llama.cpp GGUF) ----------------

/**
 * Models for the scorer (backend/src/scorer): a SEPARATE llama-server instance
 * that reads next-token probabilities instead of generating. They are
 * `llama-model` components so the existing installer puts them in the same flat
 * <configDir>/models dir, but they are NOT chat models: installing one must
 * never adopt it as `defaultLocalModel`, and LlamaManager must never pick one
 * up as its fallback chat model (see isScorerModelFile).
 *
 * The file actually used is chosen by app-config `scorerModel` (a filename in
 * the models dir), defaulting to DEFAULT_SCORER_MODEL_FILE.
 */
export interface ScorerModelDef {
  id: string;
  name: string;
  description: string;
  filename: string;
  url: string;
  bytes: number;
  sha256?: string;
  /** 'model' = weights; 'mmproj' = vision projector (optional, app-config scorerMmproj). */
  role: 'model' | 'mmproj';
}

const HF_QWEN35_9B = 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main';

export const DEFAULT_SCORER_MODEL_FILE = 'Qwen3.5-9B-BF16.gguf';

export const SCORER_MODELS: ScorerModelDef[] = [
  {
    id: 'scorer-qwen3.5-9b-bf16',
    name: 'Scorer: Qwen3.5 9B (BF16)',
    description:
      'Decision model for chaptering and flag detection. Reads answer probabilities, never generates. ~18 GB.',
    filename: DEFAULT_SCORER_MODEL_FILE,
    url: `${HF_QWEN35_9B}/Qwen3.5-9B-BF16.gguf`,
    // bytes: measured from the local copy; sha256: Hugging Face LFS oid (api/models/.../tree/main).
    bytes: 17920697312,
    sha256: 'daebe40eeea7057c1cdf35ac56d13f507d8bf12171bbb7a6b6b0d3f05439159a',
    role: 'model',
  },
  {
    id: 'scorer-qwen3.5-9b-mmproj-f16',
    name: 'Scorer: Qwen3.5 9B vision projector (F16)',
    description: 'Optional. Lets the scorer read images (set app-config scorerMmproj to its filename). ~0.9 GB.',
    filename: 'mmproj-Qwen3.5-9B-F16.gguf',
    url: `${HF_QWEN35_9B}/mmproj-F16.gguf`,
    bytes: 918166080,
    sha256: 'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f',
    role: 'mmproj',
  },
];

const SCORER_COMPONENT_IDS = new Set(SCORER_MODELS.map((m) => m.id));

/** True for a scorer component id: never a chat model, never the defaultLocalModel. */
export function isScorerModelId(id: string): boolean {
  return SCORER_COMPONENT_IDS.has(id);
}

/**
 * True for a GGUF in the models dir that belongs to the scorer (a catalog file,
 * the configured `scorerModel`/`scorerMmproj`, or any mmproj projector) and so
 * must not be offered or picked as a chat model.
 */
export function isScorerModelFile(filename: string, configured: Array<string | undefined | null> = []): boolean {
  const base = filename.replace(/\\/g, '/').split('/').pop() || filename;
  if (SCORER_MODELS.some((m) => m.filename === base)) return true;
  if (configured.some((c) => !!c && (c.replace(/\\/g, '/').split('/').pop() || c) === base)) return true;
  return /^mmproj/i.test(base);
}

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

/** Scorer models as llama-model components (installed into the same flat models dir). */
export function scorerModelComponents(): ManifestComponent[] {
  return SCORER_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    kind: 'llama-model',
    required: false,
    description: m.description,
    artifacts: universalArtifacts(m.url, m.filename, m.bytes, m.filename, m.sha256),
  }));
}

/**
 * The NLI flag-ranking environment, as a component.
 *
 * IT HAS AN ARTIFACT AND NOTHING IS EVER DOWNLOADED FROM IT. pickArtifact() is
 * how the component surface answers "is this supported on this machine?" and
 * "how big is it?", and both answers are real here: it is supported everywhere
 * (any platform with a Python 3.9+ interpreter can build it) and its size is the
 * measured on-disk size of a finished environment. Synthesising a platform-
 * agnostic artifact with an empty url keeps pickArtifact, the single-active-
 * install guard, and the abort handling in install() exactly as they are, rather
 * than threading a second "does this component need an artifact" concept through
 * all of them. The url is empty because the install path for this KIND never
 * looks at it — see installPythonEnv.
 */
export function nliEnvComponents(): ManifestComponent[] {
  return [
    {
      id: NLI_COMPONENT_ID,
      name: NLI_COMPONENT_NAME,
      kind: 'python-env',
      required: false,
      description: NLI_COMPONENT_DESCRIPTION,
      artifacts: universalArtifacts('', '', NLI_INSTALL_BYTES, 'worker.py'),
    },
  ];
}
