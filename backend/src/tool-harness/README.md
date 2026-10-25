# tool-harness

Tool calling for chat models that don't take native `tools`: the tools are
described in the system prompt, the model calls them inline in its reply, the
harness runs them and sends the results back, in a bounded loop.

Self-contained: nothing in this folder imports from outside it (no framework,
no model SDK, no database). Copy the folder into another project, or package
it, as it is.

## Use

```ts
import { runToolLoop, replayHistory, type ChatTransport, type Tool } from './tool-harness';

// 1. A transport: send messages to your model, return its text.
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
  history: replayHistory(storedTurns),        // earlier turns: [{ userMessage, trace }]
  userMessage: 'What does "idempotent" mean?',
  maxRounds: 3,
  signal,
  onEvent: (e) => console.log(e.type),        // 'model-call' | 'tool-call' | 'tool-result' | 'done'
});

result.finalText;   // the answer, tool-call tags stripped
result.toolCalls;   // [{ name, args, ok, content, data }]
result.trace;       // store it with the turn: { userMessage, trace } replays it later
result.usage;       // each model call's usage, as the transport reported it
```

A tool that can't run its arguments throws; the model is told
`couldn't run <tool>: <message>` and may call again. Aborting `signal` rejects
the loop with `ToolLoopAborted`.

## Wire format

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

The format is a `ToolCallCodec` (`tag-codec.ts`); pass `codec` to use
another. A transport for a model API that takes native `tools` can send
`functionDefinition(tool)` for each tool and render the calls it gets back in
the codec's shape.

## Rounds

A reply with no call ends the loop. After `maxRounds` rounds of calls (default
3) the results turn says no more calls can be made, and the next reply is the
last; calls it still makes are not run. The final text is every reply's prose, in
order, joined by a blank line: text written before a call ("Here are three
spots:") stays in the answer the person reads.
