"use client";

/**
 * Reading one page aloud.
 *
 * While the child reads, chunk transcripts stream back and are aligned against
 * the page so words light up as they are read — correct in green, misread in
 * amber, skipped in red. That alignment is for feedback only; when the page is
 * finished the transcript is sent to the server, which scores it again and
 * decides whether the page is passed. The client never reports its own score.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Banner, Button, Card, Empty } from "../../../components/ui";
import ReportCard, { Legend } from "../../../components/ReportCard";
import { MicIcon, SpeakerIcon } from "../../../components/Icons";
import { useLiveReadingRecorder } from "../../../lib/useLiveReadingRecorder";
import { tokenize } from "../../../../lib/reading/align";
import type { Attempt, WordMark } from "../../../../lib/reading/types";

type PageRow = {
  id: string;
  number: number;
  text: string;
  imageUrl?: string;
};

/** Colour for a word given how it has been read so far. */
function wordClass(mark: WordMark | undefined, reached: boolean): string {
  if (!mark) {
    return reached
      ? "text-[var(--foreground)]"
      : "text-[var(--text-subtle)]";
  }

  if (mark.kind === "correct") return "text-[var(--success)]";
  if (mark.kind === "substituted")
    return "rounded bg-[var(--warning-soft)] px-1 text-[var(--warning)]";

  return "rounded bg-[var(--danger-soft)] px-1 text-[var(--danger)]";
}

export default function ReadPage() {
  const params = useParams<{ assessmentId: string; pageId: string }>();
  const router = useRouter();

  const [page, setPage] = useState<PageRow | null>(null);
  const [passThreshold, setPassThreshold] = useState(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [result, setResult] = useState<Attempt | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/reading/assessment?id=${encodeURIComponent(params.assessmentId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          return;
        }

        setPassThreshold(data.assessment?.passThreshold ?? 90);
        setPage(data.pages?.find((p: PageRow) => p.id === params.pageId) ?? null);
      })
      .catch(() => setError("Could not load the page."))
      .finally(() => setLoading(false));
  }, [params.assessmentId, params.pageId]);

  const pageWords = useMemo(
    () => (page ? tokenize(page.text) : []),
    [page],
  );

  /* Streaming recorder: mic -> recognised partials -> incremental alignment.
     Words are painted the moment the recogniser's partial reaches the server,
     and only recogniser-final words are committed (and scored). Falls back to
     the chunked recorder when streaming is unavailable. */
  const recorder = useLiveReadingRecorder({
    pageWords,
    onError: setWarning,
  });

      async function finish() {
    setSubmitting(true);
    setWarning(null);

    /* Stop() flushes the streaming recogniser and returns the committed
       transcript — exactly the words that were painted. The server scores
       this same transcript again, so green and grade agree. */
    const { transcript, durationSec } = await recorder.stop();

    try {
      const res = await fetch("/api/reading/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assessmentId: params.assessmentId,
          pageId: params.pageId,
          transcript,
          durationSec,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Could not save your reading.");
        return;
      }

      setResult(data.attempt);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  function readAgain() {
    setResult(null);
    setWarning(null);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Empty>Loading…</Empty>
      </div>
    );
  }

  if (error && !page) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Banner kind="error">{error}</Banner>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Empty>That page could not be found.</Empty>
      </div>
    );
  }

  const recording = recorder.state === "recording";

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link
        href={`/student/${params.assessmentId}`}
        className="mb-3 inline-block text-xs text-[var(--text-muted)] hover:text-[var(--brand)]"
      >
        ← All pages
      </Link>

      {error && <Banner kind="error">{error}</Banner>}
      {warning && <Banner kind="info">{warning}</Banner>}

      {result ? (
        <>
          <ReportCard
            title={`Page ${page.number}`}
            score={result.score}
            marks={result.marks}
            passThreshold={passThreshold}
            complete={result.complete}
          />

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={readAgain} variant="secondary">
              Read again
            </Button>
            <Button onClick={() => router.push(`/student/${params.assessmentId}`)}>
              Back to pages
            </Button>
          </div>
        </>
      ) : (
        <>
          <Card>
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Page {page.number}</span>

              {recording && (
                <span className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--danger)]" />
                    Listening
                  </span>
                  <span>{recorder.elapsed}s</span>
                  {recorder.marks.reached > 0 && <span>{recorder.liveAccuracy}%</span>}
                </span>
              )}
            </div>

            {page.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={page.imageUrl}
                alt={`Page ${page.number}`}
                className="mb-4 max-h-72 w-full rounded-lg object-contain"
              />
            )}

            {/* Large type: this is what a child actually reads from. */}
            <div className="relative">
              {recording && (
                <span
                  className="absolute -left-1 -top-1 inline-flex rounded-full bg-[var(--brand-soft)] p-1.5 text-[var(--brand)] sm:-left-10"
                  title="Listening"
                  aria-hidden="true"
                >
                  <SpeakerIcon className="h-5 w-5" />
                </span>
              )}

              <p className="flex flex-wrap gap-x-2 gap-y-1 text-xl leading-relaxed">
                {pageWords.map((word, i) => (
                  <span
                    key={i}
                    className={`transition-colors duration-300 ${wordClass(
                      recorder.marks.byIndex.get(i),
                      i < recorder.marks.reached,
                    )}`}
                  >
                    {word}
                  </span>
                ))}
              </p>
            </div>

            {recording && (
              <div className="mt-4">
                <Legend />
              </div>
            )}
          </Card>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {!recording ? (
              <Button
                onClick={recorder.start}
                disabled={recorder.state === "finishing" || submitting}
              >
                <span className="flex items-center gap-2">
                  <MicIcon className="h-4 w-4" />
                  Start reading
                </span>
              </Button>
            ) : (
              <Button onClick={finish} disabled={submitting}>
                {submitting ? "Scoring…" : "I've finished"}
              </Button>
            )}

            {recorder.state === "finishing" && (
              <span className="text-xs text-[var(--text-muted)]">
                Listening to the last few words…
              </span>
            )}
          </div>

          {!recording && !submitting && (
            <p className="mt-3 text-[11px] text-[var(--text-subtle)]">
              Read the page out loud, clearly and at your own pace. Pass at{" "}
              {passThreshold}% of the words read correctly.
            </p>
          )}
        </>
      )}
    </div>
  );
}
