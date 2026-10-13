import { Link } from 'react-router-dom';
export function LandingPage() {
  return (
    <section className="hero">
      <p className="eyebrow">DISTRIBUTED EXECUTION, BUILT DELIBERATELY</p>
      <h1>Build, submit, <em>observe.</em></h1>
      <p className="lede">
        Solve programming problems and submit code to an asynchronous queue. Isolated execution is
        the next step in the build.
      </p>
      <div className="actions">
        <Link className="button" to="/problems">Browse problems</Link>
        <Link className="text-link" to="/register">Create an account →</Link>
      </div>
      <div className="architecture">
        <div>React client</div><i>→</i><div>Modular API</div><i>→</i><div>PostgreSQL</div>
        <i>→</i><div>RabbitMQ</div><i>→</i><div>Worker · next</div>
      </div>
    </section>
  );
}
