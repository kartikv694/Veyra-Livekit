"use client";

/**
 * /meeting-report/[token]
 *
 * Host-only. A dedicated, standalone view of a meeting's AI analysis —
 * what "View report" on the dashboard links to for any past meeting that
 * has one (see hasAnalysis in GET /api/rooms). Deliberately separate from
 * /meeting-ended/[token]/page.tsx, which shows the same kind of table but
 * is built around the moment right after a meeting ends (auto-return
 * countdown, "Rejoin" option, polling for analysis that might still be
 * in progress). None of that applies here — a report someone's opening
 * from the dashboard, possibly days later, already exists in full, so
 * this is a single fetch on mount, no polling.
 */
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { BrandLink } from "@/components/BrandLink";
import { toast } from "@/lib/toast";
import { authHeaders } from "@/lib/auth-client";

interface ParticipantAnalysisRow {
  userId: number;
  name: string;
  communication: number;
  fluency: number;
  topicKnowledge: number;
  teamworkListening: number;
  leadershipInitiative: number;
  confidenceProfessionalism: number;
  summary: string | null;
}

const MAX_SCORE = 5;

const SCORE_LABELS: { key: keyof Omit<ParticipantAnalysisRow, "userId" | "name" | "summary">; label: string }[] = [
  { key: "communication", label: "Communication" },
  { key: "fluency", label: "Fluency" },
  { key: "topicKnowledge", label: "Topic knowledge" },
  { key: "teamworkListening", label: "Teamwork & listening" },
  { key: "leadershipInitiative", label: "Leadership & initiative" },
  { key: "confidenceProfessionalism", label: "Confidence & professionalism" },
];

export default function MeetingReportPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [meetingTitle, setMeetingTitle] = useState<string | null>(null);
  const [meetingDate, setMeetingDate] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ParticipantAnalysisRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/rooms/${params.token}/analysis`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setErrorMessage(data.error ?? "Couldn't load this report.");
          setState("error");
          return;
        }
        const rows: ParticipantAnalysisRow[] = Array.isArray(data.analysis) ? data.analysis : [];
        setMeetingTitle(data.meeting?.title ?? null);
        setMeetingDate(data.meeting?.endAt ?? data.meeting?.createdAt ?? null);
        setAnalysis(rows);
        setState("ready");
      } catch {
        if (!cancelled) {
          setErrorMessage("Couldn't reach the server. Check your connection and try again.");
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.token]);

  useEffect(() => {
    if (state === "error") toast.error(errorMessage);
  }, [state, errorMessage]);

  return (
    <div className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-fg"
          >
            <ArrowLeft size={16} />
            Back to dashboard
          </button>
          <BrandLink size={22} />
        </div>

        {state === "loading" && (
          <div className="mt-16 flex items-center justify-center gap-3 text-muted">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <span className="text-sm">Loading report…</span>
          </div>
        )}

        {state === "error" && (
          <div className="mt-16 rounded-xl border border-edge bg-surface p-6 text-center">
            <p className="text-sm text-muted">{errorMessage}</p>
          </div>
        )}

        {state === "ready" && (
          <div className="mt-10">
            <h1 className="text-center font-display text-2xl font-semibold sm:text-3xl">
              {meetingTitle || "Meeting analysis"}
            </h1>
            {meetingDate && (
              <p className="mt-1 text-center text-sm text-muted">{new Date(meetingDate).toLocaleString()}</p>
            )}
            <p className="mt-3 text-center text-sm text-muted">
              AI-generated, based on what each participant said during the meeting. Each parameter scored out of {MAX_SCORE}.
            </p>

            {analysis.length === 0 ? (
              <div className="mt-10 rounded-xl border border-edge bg-surface p-6 text-center text-sm text-muted">
                No analysis was recorded for this meeting.
              </div>
            ) : (
              <>
                <div className="mt-8 overflow-x-auto rounded-xl border border-edge">
                  <table className="w-full min-w-[720px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-edge bg-surface">
                        <th className="sticky left-0 bg-surface px-4 py-3 text-left font-medium">Participant</th>
                        {SCORE_LABELS.map(({ key, label }) => (
                          <th key={key} className="px-3 py-3 text-center font-medium text-muted">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.map((row, i) => (
                        <tr key={row.userId} className={i % 2 === 1 ? "bg-white/[0.02]" : undefined}>
                          <td className="sticky left-0 whitespace-nowrap bg-inherit px-4 py-3 font-medium">{row.name}</td>
                          {SCORE_LABELS.map(({ key }) => (
                            <td key={key} className="px-3 py-3 text-center">
                              <span className="font-semibold">{row[key]}</span>
                              <span className="text-muted">/{MAX_SCORE}</span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {analysis.some((row) => row.summary) && (
                  <div className="mt-4 space-y-2">
                    {analysis
                      .filter((row) => row.summary)
                      .map((row) => (
                        <p key={row.userId} className="text-sm text-muted">
                          <span className="font-medium text-fg">{row.name}:</span> {row.summary}
                        </p>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
