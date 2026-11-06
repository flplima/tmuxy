/**
 * Where a preview's bytes come from: `read_preview` and `stagePreview` on the
 * app's transport, answered straight to the widget rather than through the
 * machine (see `AppRuntimeContext`).
 */

import { useMemo } from 'react';
import { Effect, Schema } from 'effect';
import { TmuxTransport } from '../../../infra/transport/TmuxTransport';
import {
  formatAdapterError,
  ProtocolError,
  type AdapterError,
} from '../../../infra/transport/AdapterError';
import { useAppRuntime } from '../../../machines/appHooks';
import { PreviewDocument, PreviewResource } from '../../../domain/preview';
import type { PaneId } from '../../../domain/ids';

export interface PreviewSource {
  readDocument(): Promise<PreviewDocument>;
  /** A resource by its document-relative path (`previewResourcePath`). */
  readResource(path: string): Promise<PreviewResource>;
  /** Stage the page for the pane's frame; the URL to load it from. */
  stagePage(html: string): Promise<string>;
}

export function usePreviewSource(paneId: PaneId): PreviewSource {
  const runtime = useAppRuntime();
  return useMemo(() => {
    const run = <A>(program: (t: typeof TmuxTransport.Service) => Effect.Effect<A, AdapterError>) =>
      runtime.runPromise(
        Effect.flatMap(TmuxTransport, program).pipe(
          Effect.mapError((e) => new Error(formatAdapterError(e))),
        ),
      );
    /** `read_preview`, whose answer must be the kind of read asked for. */
    const read = <A, I>(schema: Schema.Schema<A, I>, path?: string) =>
      run((t) =>
        t.call('read_preview', path === undefined ? { paneId } : { paneId, path }).pipe(
          Effect.flatMap(
            (answer): Effect.Effect<A, ProtocolError> =>
              Schema.is(schema)(answer)
                ? Effect.succeed(answer)
                : Effect.fail(
                    new ProtocolError({
                      reason: 'read_preview answered another kind of read',
                      raw: answer,
                    }),
                  ),
          ),
        ),
      );
    return {
      readDocument: () => read(PreviewDocument),
      readResource: (path: string) => read(PreviewResource, path),
      stagePage: (html: string) => run((t) => t.stagePreview(paneId, html)),
    };
  }, [runtime, paneId]);
}
