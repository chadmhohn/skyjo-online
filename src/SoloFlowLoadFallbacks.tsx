export function RouteLoadFallback() {
  return <main className="skyjo-surface p-6" role="status">Loading Flipvale… Your saved game is safe.</main>;
}

export function RouteLoadFailure() {
  return (
    <main className="skyjo-surface p-6">
      <p role="alert">This screen could not load. Reload Flipvale; your saved game is safe.</p>
    </main>
  );
}
