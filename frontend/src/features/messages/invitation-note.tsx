import { Textarea } from '@/components/ui/textarea';

export function InvitationNoteField({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  return <label className="my-3 block">
    <span className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Invitation note (optional)</span>
    <Textarea value={value} onChange={event => onChange(event.target.value)} disabled={disabled}
      maxLength={500} rows={3} placeholder="Explain what this group is about and why you're inviting them." />
    <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">Shown to each person you invite before they accept. Up to 500 characters.</span>
  </label>;
}

export function InvitationContext({ note }: { note?: string | null }) {
  return <div className="mt-2">
    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Invitation note</p>
    <p className="whitespace-pre-wrap break-words">{note || 'No invitation note was included.'}</p>
  </div>;
}
