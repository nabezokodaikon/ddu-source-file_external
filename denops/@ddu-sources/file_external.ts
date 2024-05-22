import {
  BaseSource,
  Item,
  SourceOptions,
} from "https://deno.land/x/ddu_vim@v4.1.0/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v4.1.0/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.7.1/file.ts";
import { abortable } from "https://deno.land/std@0.224.0/async/mod.ts";
import { TextLineStream } from "https://deno.land/std@0.224.0/streams/mod.ts";

const enqueueSize1st = 1000;

type Params = {
  cmd: string[];
  updateItems: number;
};

async function* iterLine(r: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const lines = r
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());

  for await (const line of lines) {
    const lineStr = line as string;
    if (lineStr.length) {
      yield lineStr;
    }
  }
}

export class Source extends BaseSource<Params> {
  kind = "file";

  gather(args: {
    denops: Denops;
    sourceOptions: SourceOptions;
    sourceParams: Params;
  }): ReadableStream<Item<ActionData>[]> {
    const abortController = new AbortController();
    const { denops, sourceOptions, sourceParams } = args;
    return new ReadableStream({
      async start(controller) {
        let root = await fn.fnamemodify(
          denops,
          sourceOptions.path,
          ":p",
        ) as string;
        if (root == "") {
          root = await fn.getcwd(denops) as string;
        }

        if (!args.sourceParams.cmd.length) {
          return;
        }

        let items: Item<ActionData>[] = [];
        const enqueueSize2nd = sourceParams.updateItems;
        let enqueueSize = enqueueSize1st;
        let numChunks = 0;

        const proc = new Deno.Command(
          sourceParams.cmd[0],
          {
            args: sourceParams.cmd.slice(1),
            stdout: "piped",
            stderr: "piped",
            cwd: root,
          },
        ).spawn();

        if (!proc || proc.stdout === null) {
          controller.close();
          return;
        }
        try {
          for await (
            const line of abortable(
              iterLine(proc.stdout),
              abortController.signal,
            )
          ) {
            const path = line.trim();
            if (!path.length) continue;

            items.push({
              word: path,
              action: {
                path: path,
              },
            });
            if (items.length >= enqueueSize) {
              numChunks++;
              if (numChunks > 1) {
                enqueueSize = enqueueSize2nd;
              }
              controller.enqueue(items);
              items = [];
            }
          }
          if (items.length) {
            controller.enqueue(items);
          }
        } catch (e: unknown) {
          if (e instanceof DOMException) {
            proc.kill("SIGTERM");
          } else {
            console.error(e);
          }
        } finally {
          const status = await proc.status;
          if (!status.success) {
            for await (
              const line of abortable(
                iterLine(proc.stderr),
                abortController.signal,
              )
            ) {
              console.error(line);
            }
          }
          controller.close();
        }
      },

      cancel(reason): void {
        abortController.abort(reason);
      },
    });
  }

  params(): Params {
    return {
      cmd: [],
      updateItems: 100000,
    };
  }
}
