import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Stops one broken render from blanking the application.
 *
 * React unmounts the whole tree when a render or lifecycle method throws and nothing catches it,
 * so a single bad value — a null where a shape was expected, a date that will not parse — leaves
 * a white page with the reason only in the console. That risk rises with externally-authored
 * data: a spreadsheet import can put values in the database that no screen has ever had to render.
 *
 * Only a class component can be an error boundary; there is no hook equivalent.
 *
 * Limits worth knowing, because they decide where this helps: it catches errors thrown while
 * rendering, in lifecycle methods, and in constructors below it. It does NOT catch errors inside
 * event handlers, in `setTimeout`, or in rejected promises — those never interrupt a render, and
 * the API layer already surfaces them as toasts.
 */
interface Props {
  children: ReactNode;
  /** Shown above the message, e.g. "This page". Defaults to "Something". */
  what?: string;
  /** Rendered instead of the default panel, when a caller wants its own fallback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // Keep the original report intact — the boundary changes what the user sees, not what a
    // developer can find in the console.
    // eslint-disable-next-line no-console
    console.error('Unhandled render error:', error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null, info: null });

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="card" style={{ borderLeft: '4px solid var(--bad)', maxWidth: 720, margin: '24px auto' }}>
        <h3 style={{ margin: '0 0 8px', color: '#991b1b', fontSize: 16 }}>
          ⚠ {this.props.what ?? 'Something'} could not be displayed
        </h3>
        <p style={{ margin: '0 0 14px', color: 'var(--text-2)', fontSize: 13.5, lineHeight: 1.5 }}>
          An unexpected error stopped this from rendering. Nothing you had already saved is
          affected — this is a display failure, not a data one. Try again, or move to another
          screen and come back.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary sm" onClick={this.reset}>↻ Try again</button>
          <button className="btn ghost sm" onClick={() => window.location.reload()}>Reload the page</button>
        </div>
        {/* Collapsed by default: useful when reporting the fault, noise the rest of the time. */}
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>Technical details</summary>
          <pre style={{
            marginTop: 8, padding: 10, background: 'var(--surface-3)', borderRadius: 8, fontSize: 11.5,
            lineHeight: 1.45, color: 'var(--text-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 260, overflow: 'auto',
          }}>
            {error.message}
            {info?.componentStack ?? ''}
          </pre>
        </details>
      </div>
    );
  }
}
