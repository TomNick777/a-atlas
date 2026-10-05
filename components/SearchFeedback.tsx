"use client";

import { useState } from "react";
import { trackClientEvent } from "@/lib/telemetry/client";
import { FEEDBACK_RATINGS, FEEDBACK_REASONS, type FeedbackRating, type FeedbackReason } from "@/lib/telemetry/types";

/**
 * §8 Lightweight search feedback — 好/一般/差 plus one optional reason, tied to
 * the search trace id. One line of text, never a questionnaire, never a modal,
 * always skippable; sending is fire-and-forget and cannot fail the UI.
 */

const RATING_LABEL: Record<FeedbackRating, string> = { good: "好", neutral: "一般", bad: "差" };

const REASON_LABEL: Record<FeedbackReason, string> = {
  missing_company: "漏掉了我想找的公司",
  bad_ranking: "排名不合理",
  irrelevant: "结果不相关",
  too_slow: "搜索太慢",
  evidence_insufficient: "解释/证据不够",
  other: "其他",
};

export function SearchFeedback({ searchId, query }: { searchId: string | null; query: string }) {
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [reason, setReason] = useState<FeedbackReason | null>(null);
  // Reset per search during render (React's adjust-state-on-prop-change form) —
  // a new trace id means the previous feedback row is done.
  const [seenSearchId, setSeenSearchId] = useState(searchId);
  if (seenSearchId !== searchId) {
    setSeenSearchId(searchId);
    setRating(null);
    setReason(null);
  }

  if (!searchId) return null;

  const send = (next: FeedbackRating, why?: FeedbackReason) => {
    trackClientEvent("SEARCH_FEEDBACK", { rating: next, ...(why ? { reason: why } : {}), query: query || null }, searchId);
  };

  return (
    <div className="mt-2 text-center text-[12px] text-[#8d887c]">
      {rating === null ? (
        <p className="pointer-events-auto">
          这些结果怎么样？
          {FEEDBACK_RATINGS.map((value, index) => (
            <span key={value}>
              {index > 0 && <span className="mx-1.5 text-[#57534a]">·</span>}
              <button
                type="button"
                className="transition-colors duration-200 hover:text-[#d9d4c8]"
                onClick={() => {
                  setRating(value);
                  send(value);
                }}
              >
                {RATING_LABEL[value]}
              </button>
            </span>
          ))}
        </p>
      ) : (
        <p>
          <span className="text-[#57534a]">已记下：</span>
          {RATING_LABEL[rating]}
          {reason && <span className="ml-2 text-[#57534a]">（{REASON_LABEL[reason]}）</span>}
        </p>
      )}
      {rating !== null && reason === null && (
        <p className="pointer-events-auto mt-1">
          {FEEDBACK_REASONS.map((value, index) => (
            <span key={value}>
              {index > 0 && <span className="mx-1.5 text-[#57534a]">·</span>}
              <button
                type="button"
                className="transition-colors duration-200 hover:text-[#d9d4c8]"
                onClick={() => {
                  setReason(value);
                  send(rating, value);
                }}
              >
                {REASON_LABEL[value]}
              </button>
            </span>
          ))}
          <span className="mx-1.5 text-[#57534a]">·</span>
          <span className="text-[#57534a]">不选也行</span>
        </p>
      )}
    </div>
  );
}
