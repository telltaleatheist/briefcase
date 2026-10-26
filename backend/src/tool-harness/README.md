# tool-harness

Tool calling for chat models, in a bounded loop: the model calls tools, the
harness runs them and sends the results back. Two wire formats: **native**
(the tools sent as OpenAI `tools` definitions, the calls read from the
reply's structured `tool_calls`) for a model API that takes them, and
**tags** (the tools described in the system prompt, the calls read inline
from the reply's text) for one that doesn't.

Self-contained: nothing in this folder imports from outside it (no framework,
no model SDK, no database). Copy the folder into another project, or package
it, as it is.

## Use

```ts
import { runToolLoop, replayHistory, type ChatTransport, type Tool } from './tool-harness';

// 1. A transport: send messages to your model, return its text (and, native, its calls).
//    Shown for the tag format; the native one is under "Native format".
const transport: ChatTransport = async (messages, { signal }) => {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ model, messages }), signal });
  const body = await res.json();
  return { text: body.choices[0].message.content, usage: body.usage };
};

// 2. Tools: a JSON Schema for the arguments, and execute.
const lookup: Tool<{ word: string }, { definition: string }> = {
  name: 'lookup',
  description: 'Look a word up in the glossary.',
  parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
  async execute({ word }) {
    const definition = glossary[word];
    if (!definition) return { content: `"${word}" is not in the glossary` };
    return { content: definition, data: { definition } };   // content goes to the model, data stays with you
  },
};

// 3. The loop.
const result = await runToolLoop({
  transport,
  tools: [lookup],
  system: 'You answer questions about the glossary.',
  history: replayHistory(storedTurns),        // earlier turns: [{ userMessage, trace }], replayed for the codec (default tags)
  userMessage: 'What does "idempotent" mean?',
  maxRounds: 3,
  signal,
  onEvent: (e) => console.log(e.type),        // 'model-call' | 'tool-call' | 'tool-result' | 'done'
  // codec: nativeCodec,                      // the native format (default tagCodec)
});

result.finalText;   // the answer: every reply's prose, tool-call tags stripped
result.toolCalls;   // [{ name, args, ok, content, data }]
result.trace;       // store it with the turn: { userMessage, trace } replays it later
result.usage;       // each model call's usage, as the transport reported it
```

A tool that can't run its arguments throws; the model is told
`couldn't run <tool>: <message>` and may call again. Aborting `signal` rejects
the loop with `ToolLoopAborted`.

## Native format

`nativeCodec` (`native-codec.ts`). The loop hands the transport the tools as
definitions in its options (`opts.tools`, each tool's `functionDefinition`,
the OpenAI `tools` entry), and puts nothing about them in the prompt. The
transport sends them, and returns the reply's calls flattened:

```ts
const transport: ChatTransport = async (messages, { signal, tools }) => {
  const body = { model, messages: messages.map(toOpenAI), ...(tools ? { tools, tool_choice: 'auto' } : {}) };
  const reply = (await (await fetch(url, { method: 'POST', body: JSON.stringify(body), signal })).json()).choices[0].message;
  return {
    text: reply.content ?? '',
    toolCalls: (reply.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
    usage,
  };
};
// toOpenAI: an assistant message's `toolCalls` → `tool_calls` (content null when ''),
// a `tool` message's `toolCallId` → `tool_call_id`; anything else as it is.
```

`ChatMessage` carries both: an assistant message may have `toolCalls`
(`{ id, name, arguments }`, the arguments a JSON string, the id opaque and
sent back exactly), and a `role: 'tool'` message has the `toolCallId` it
answers. A round's results are one `tool` message per call, after the
assistant message exactly as it came. Arguments that aren't a JSON object are
answered `couldn't read that tool call: …`, as an unreadable tag is.

## Tag format

Plain-text tags shaped like Qwen's tool template, but not its `<tool_call>` / `<tool_response>`: those are special tokens, and an engine that knows them (mlx-lm's server) lifts the call out of the reply into a `tool_calls` field that a door may not relay, leaving an empty reply. Ordinary tags pass through every engine as text.

The system prompt gets a `# Tools` section listing each tool's function
definition (the OpenAI `tools` entry shape) inside `<tools></tools>`. The model
calls a tool inline, any number of times per reply:

```
<tool_use>
{"name": "lookup", "arguments": {"word": "idempotent"}}
</tool_use>
```

Calls are read leniently (code fences, stray whitespace, `arguments` as a JSON
string, a block cut off at the end of the reply). A block that still can't be
read is answered `couldn't read that tool call: <reason>`. The results go back
as the next user turn, one block per call:

```
<tool_result>
...
</tool_result>
```

## Codecs and replay

A format is a `ToolCallCodec`: `toolsPrompt` (the prompt section, '' for
native), `definitions` (native only), `read` (a reply into prose, calls and
its trace message), `results`, `unanswered` (native only, below) and
`replay`. Pass `codec` to the loop, and the same codec to `replayHistory`.

A thread can hold turns stored in either format (a thread from before native
tools, a model switched mid-thread, a model that fell back to tags), so each
codec's `replay` reads both into its own:

- **tags → native**: an assistant reply's `<tool_use>` blocks become its
  structured `toolCalls` (ids `replay_<turn>_<n>`), its prose the message's
  text, and the `<tool_result>` turn after it the matching `tool` messages
  (a last-round note goes on the last). A block that couldn't be read (and
  its result), and calls a last reply made that were never run, are dropped:
  neither had an effect. The model sees only its own format, with no tags in
  its history to imitate.
- **native → tags**: the calls become `<tool_use>` blocks after the text, and
  the `tool` messages one `<tool_result>` user turn.
- **Claude format** (`claude-codec.ts`, for a Claude model reached as plain
  text, e.g. `claude -p`): tools described and called in the
  `<function_calls><invoke name=…><parameter name=…>` shape Claude was trained
  on, results as one `<function_results>` turn (`<result><tool_name>…
  <stdout>…`, or `<error>` for a call that couldn't be read). It replays native
  and tag traces into that shape, and native replay reads it back. Its reader
  is the tag codec's, so `<tool_use>` tags still count.

Which format a model gets is the host's choice; Briefcase makes it in one
place (`video-chat/tool-format.ts`).

## Rounds

A reply with no call ends the loop. After `maxRounds` rounds of calls (default
3) the results say no more calls can be made (the tag results turn ends with
the note; natively it is appended to the last `tool` message), and the next
reply is the last; calls it still makes are not run. Natively the trace still
answers each of them `Not run: …` (`unanswered`), so the stored trace is a
conversation a model API takes back. The final text is every reply's prose, in
order, joined by a blank line: text written before a call ("Here are three
spots:") stays in the answer the person reads.
