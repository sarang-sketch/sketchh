// Daily briefing host: the lazy boundary for the briefing panel.
//
// SidePanel must not import `buildBriefing` (or anything from
// `./dailyBriefing`) directly: that module is also imported by
// `DailyBriefing.tsx`, and a static import from the Code shell pulls the
// briefing component's chunk into the IdeLayout chunk, which breaks the
// bundle check's lazy-loading boundary (`IdeLayout.tsx` must stay its own
// dynamic entry). Everything briefing-related lives behind this one lazy
// import instead, so the panel — helper and component alike — loads only
// when the user opens it.
import { buildBriefing } from './dailyBriefing';
import { DailyBriefing } from './DailyBriefing';
import type { Conversation } from '../state/AppState';

export function DailyBriefingHost({ conversations }: { conversations: Conversation[] }) {
  // Built from what this window actually recorded: its conversations.
  // No runs, costs or tasks are seeded — with no conversations the panel
  // correctly shows its empty state.
  const items = buildBriefing(
    conversations.map((conversation) => ({
      kind: 'conversation' as const,
      title: conversation.title,
      detail: `${conversation.messages.length} message(s)`,
      at: conversation.updatedAt ?? conversation.createdAt,
    })),
  );
  return <DailyBriefing date={new Date().toISOString().slice(0, 10)} items={items} />;
}
