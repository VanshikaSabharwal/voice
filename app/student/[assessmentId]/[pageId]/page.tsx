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
    const { transcript, durationSec, recovered } = await recorder.stop();

    if (recovered > 0) {
      console.info(
        `[reading] recovered ${recovered} word(s) the recogniser dropped from its finals`,
      );
    }

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
  const connecting = recorder.state === "connecting";

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
          {/* Start sits above the page text: a child taps it, then looks down
              and begins. The stop control is below the text, where their eyes
              land when they reach the end. */}
          {!recording && (
            <div className="mb-4">
              <Button
                onClick={recorder.start}
                disabled={connecting || recorder.state === "finishing" || submitting}
              >
                <span className="flex items-center gap-2">
                  {connecting ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      Getting ready…
                    </>
                  ) : (
                    <>
                      <MicIcon className="h-4 w-4" />
                      Start listening
                    </>
                  )}
                </span>
              </Button>

              {connecting && (
                <p className="mt-2 text-[11px] text-[var(--text-subtle)]">
                  Just a moment — wait until it says <strong>Speak now</strong>.
                </p>
              )}
            </div>
          )}

          {/* The moment capture is genuinely live. Until this appears, nothing
              a child says is being recorded. */}
          {recording && (
            <div
              role="status"
              aria-live="assertive"
              className="mb-4 flex items-center gap-3 rounded-lg border border-[var(--success)] bg-[var(--success-soft)] px-4 py-3"
            >
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--success)] opacity-60" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--success)]" />
              </span>
              <span className="text-base font-semibold text-[var(--success)]">
                Speak now
              </span>
              <span className="ml-auto flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
                <span>{recorder.elapsed}s</span>
                {recorder.marks.reached > 0 && <span>{recorder.liveAccuracy}%</span>}
              </span>
            </div>
          )}

          <Card>
            {/* Elapsed and accuracy live in the "Speak now" banner above, so
                they are not repeated here. */}
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Page {page.number}</span>
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

          {/* Stop sits below the text: it is where a child's eyes already are
              when they finish the last line. */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {recording && (
              <Button onClick={finish} disabled={submitting} variant="danger">
                {submitting ? "Scoring…" : "Stop listening"}
              </Button>
            )}

            {recorder.state === "finishing" && (
              <span className="text-xs text-[var(--text-muted)]">
                Listening to the last few words…
              </span>
            )}
          </div>

          {!recording && !connecting && !submitting && (
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
