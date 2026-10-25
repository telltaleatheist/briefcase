/**
 * The tool harness's types. Self-contained: nothing here imports from the app
 * that hosts it, so the folder can be copied into another project as it is.
 */

/** One chat message as a transport sends it. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** What a transport returns for one model call. */
export interface TransportReply {
  /** The model's reply as text, tool-call tags and all. */
  text: string;
  /** Whatever the host's model API reports; kept per call in the loop's result. */
  usage?: unknown;
}

/** How the loop reaches a model: the host supplies it (an HTTP client, an SDK, a fake in a test). */
export type ChatTransport = (messages: ChatMessage[], opts: { signal?: AbortSignal }) => Promise<TransportReply>;

/** What a tool's execute gets besides its arguments. */
export interface ToolContext {
  signal?: AbortSignal;
}

/**
 * A tool the model may call.
 *
 * `content` is what goes back to the model as the call's result; `data` is the
 * structured result the host keeps (a placed marker, a row id). A tool that
 * can't run its arguments throws: the model is told why and may call again.
 */
export interface Tool<Args = Record<string, unknown>, Result = unknown> {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
  execute(args: Args, ctx: ToolContext): Promise<{ content: string; data?: Result }>;
}

/** One tool call as the loop ran it. */
export interface ToolCallRecord<Result = unknown> {
  /** The tool named, or null when the call could not be read. */
  name: string | null;
  args: Record<string, unknown> | null;
  /** True when the call was read and its tool ran without throwing. */
  ok: boolean;
  /** What the model was sent back for it. */
  content: string;
  data?: Result;
}

/** A call found in a reply, read or not. */
export type ParsedToolCall =
  | { ok: true; name: string; args: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * A tool-call wire format: how tools are described to the model, how its calls
 * are read out of a reply, and how results go back. The plain tag format
 * (tag-codec.ts) is one; a native-tools transport would bring its own.
 */
export interface ToolCallCodec {
  /** The block appended to the system prompt that describes the tools and how to call them. */
  toolsPrompt(tools: ReadonlyArray<Tool<any, any>>): string;
  /** A reply's prose (the calls cut out) and the calls in it, in order. */
  parse(text: string): { prose: string; calls: ParsedToolCall[] };
  /** The user turn carrying one round's results, in call order; `note` is appended when given. */
  responses(contents: string[], note?: string): string;
}

/** What the loop reports as it goes, for a host's progress display. */
export type ToolLoopEvent =
  | { type: 'model-call'; round: number }
  | { type: 'tool-call'; round: number; name: string | null; args: Record<string, unknown> | null }
  | { type: 'tool-result'; round: number; call: ToolCallRecord }
  | { type: 'done'; rounds: number };
