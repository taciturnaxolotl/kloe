import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, type LanguageModel } from "ai";

/**
 * Chose HYPER_MODEL=echo: streams back "echo: <prompt>" token-by-token,
 * so the whole pipeline (claim → stream → persist → fan-out) is observable
 * without a real upstream. With a real HYPER_BASE_URL/API_KEY this adapter
 * calls the OpenAI-compatible endpoint.
 */
export function createModel(model: string): LanguageModel {
  // No upstream configured: use the deterministic echo adapter so the whole
  // pipeline (claim → stream → persist → fan-out) is observable offline.
  if (!process.env.HYPER_BASE_URL && model === "echo") {
    const chunkDelayMs = Number(process.env.ECHO_DELAY_MS ?? 5);
    return {
      specificationVersion: "v4",
      provider: "kloe-mock",
      modelId: "echo",
      supportedUrls: {},
      doStream: async (opts: { prompt: unknown; abortSignal?: AbortSignal }) => {
        // v4 prompt is a message array; pull the last user text part.
        const messages = (opts.prompt ?? []) as Array<{
          role: string;
          content: unknown;
        }>;
        const last = messages.filter((m) => m.role === "user").at(-1);
        const parts = Array.isArray(last?.content)
          ? (last!.content as Array<{ type: string; text?: string }>)
          : [];
        const userText = parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
        const text = `echo: ${userText}`;
        const chunks = text.split(/(?<=\s)/);
        let i = 0;
        let id = 0;
        const signal = opts.abortSignal;
        const stream = new ReadableStream<Record<string, unknown>>({
          pull: async (controller) => {
            // Honor abort: stop generating and close the stream.
            if (signal?.aborted) {
              controller.close();
              return;
            }
            if (i === 0) {
              controller.enqueue({ type: "text-start", id: `t${id++}` });
            }
            if (i >= chunks.length) {
              controller.enqueue({ type: "text-end", id: `t${id++}` });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              controller.close();
              return;
            }
            controller.enqueue({
              type: "text-delta",
              id: `t${id++}`,
              delta: chunks[i++],
            });
            await Bun.sleep(chunkDelayMs);
          },
        });
        return { stream };
      },
    } as unknown as LanguageModel;
  }

  const compat = createOpenAICompatible({
    name: "hyper",
    baseURL: process.env.HYPER_BASE_URL ?? "http://localhost:11434/v1",
    apiKey: process.env.HYPER_API_KEY ?? "KLOE-MOCK",
  });
  return compat(model);
}

export async function* run(
  prompt: string,
  opts: { model: string; runId: string; abortSignal?: AbortSignal },
): AsyncGenerator<{ kind: "text"; chunk: string }> {
  const model = createModel(opts.model);
  const result = streamText({
    model,
    prompt,
    temperature: 0.7,
    abortSignal: opts.abortSignal,
  });
  for await (const chunk of result.textStream) {
    yield { kind: "text", chunk };
  }
}
