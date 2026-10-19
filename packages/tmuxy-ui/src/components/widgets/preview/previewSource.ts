/**
 * Where a preview's bytes come from: `read_preview` and `stagePreview` on the
 * app's transport, answered straight to the widget rather than through the
 * machine (see `AppRuntimeContext`).
 */

import { useMemo } from 'react';
import { Effect } from 'effect';
import { TmuxTransport } from '../../../infra/transport/TmuxTransport';
import { formatAdapterError, type AdapterError } from '../../../infra/transport/AdapterError';
import { useAppRuntime } from '../../../machines/appHooks';
import type { PreviewDocument, PreviewResource } from '../../../domain/preview';
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
    return {
      readDocument: () => run((t) => t.invoke<PreviewDocument>('read_preview', { paneId })),
      readResource: (path: string) =>
        run((t) => t.invoke<PreviewResource>('read_preview', { paneId, path })),
      stagePage: (html: string) => run((t) => t.stagePreview(paneId, html)),
    };
  }, [runtime, paneId]);
}
