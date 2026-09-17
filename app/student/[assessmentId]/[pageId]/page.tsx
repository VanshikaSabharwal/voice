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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Banner, Button, Card, Empty } from "../../../components/ui";
import ReportCard, { Legend } from "../../../components/ReportCard";
import { MicIcon, SpeakerIcon } from "../../../components/Icons";
import { useReadingRecorder } from "../../../lib/useReadingRecorder";
import { alignLive, tokenize } from "../../../../lib/reading/align";
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

  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState<Attempt | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /* The transcript is also held in a ref: stop() resolves after the last chunk
     lands, and reading state at that moment would give the value from before
     the final update. */
  const transcriptRef = useRef("");

  const appendTranscript = useCallback((text: string) => {
    transcriptRef.current = `${transcriptRef.current} ${text}`.trim();
    setTranscript(transcriptRef.current);
  }, []);

  const recorder = useReadingRecorder({
    onTranscript: appendTranscript,
    onError: setWarning,
  });

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

  /* Live alignment of what has been heard so far. Uses a forward-only
     cursor (alignLive) rather than full-page Needleman-Wunsch, which would
     latch common words onto later lines the child has not reached. */
  const liveMarks = useMemo(() => {
    if (!transcript.trim() || pageWords.length === 0) return [];
    return alignLive(pageWords, tokenize(transcript));
  }, [pageWords, transcript]);

  /** Mark per page-word index, for colouring the text as it is read. */
  const markByIndex = useMemo(() => {
    const map = new Map<number, WordMark>();

    for (const mark of liveMarks) {
      if (mark.index >= 0) map.set(mark.index, mark);
    }

    return map;
  }, [liveMarks]);

  /* How far the child has read. Trailing omissions are words not yet reached
     rather than skipped ones, so they must not be shown as errors mid-read. */
  const reachedUpTo = useMemo(() => {
    let last = -1;

    for (const mark of liveMarks) {
      if (mark.index >= 0 && mark.kind !== "omitted") last = mark.index;
    }

    return last;
  }, [liveMarks]);

  const liveAccuracy = useMemo(() => {
    if (reachedUpTo < 0) return 0;

    let correct = 0;

    for (let i = 0; i <= reachedUpTo; i++) {
      if (markByIndex.get(i)?.kind === "correct") correct++;
    }

    return Math.round((correct / pageWords.length) * 100);
  }, [markByIndex, pageWords.length, reachedUpTo]);

  async function finish() {
    setSubmitting(true);
    setWarning(null);

    const durationSec = await recorder.stop();

    try {
      const res = await fetch("/api/reading/attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assessmentId: params.assessmentId,
          pageId: params.pageId,
          transcript: transcriptRef.current,
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
    transcriptRef.current = "";
    setTranscript("");
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
                  {reachedUpTo >= 0 && <span>{liveAccuracy}%</span>}
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
                      markByIndex.get(i),
                      i <= reachedUpTo,
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
