export default function Placeholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
      <div className="mt-6 rounded-xl border border-dashed border-[var(--border-strong)] bg-white p-10 text-center">
        <p className="text-sm text-[var(--text-subtle)]">Not built yet.</p>
      </div>
    </div>
  );
}
