import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './services/api';
import { AdminContestCreatePage } from './pages/AdminContestCreatePage';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { ContestDetailsPage } from './pages/ContestDetailsPage';
import { ContestsPage } from './pages/ContestsPage';
import { ProblemDetailsPage } from './pages/ProblemDetailsPage';
import { ProblemsPage } from './pages/ProblemsPage';
import { RegisterPage } from './pages/RegisterPage';
import { SubmissionDetailsPage } from './pages/SubmissionDetailsPage';
import { SubmissionsPage } from './pages/SubmissionsPage';
import { WorkerStatusPage } from './pages/WorkerStatusPage';

function SiteHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isAuthenticated, setIsAuthenticated] = useState(() =>
    Boolean(localStorage.getItem('token')),
  );
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const authenticated = Boolean(localStorage.getItem('token'));
    setIsAuthenticated(authenticated);
    if (!authenticated) {
      setIsAdmin(false);
      return;
    }
    let active = true;
    void api
      .get<{ user: { role: string } }>('/auth/me')
      .then(({ data }) => {
        if (active) setIsAdmin(data.user.role === 'ADMIN');
      })
      .catch(() => {
        if (active) setIsAdmin(false);
      });
    return () => {
      active = false;
    };
  }, [location.pathname]);

  function logOut() {
    localStorage.removeItem('token');
    setIsAuthenticated(false);
    setIsAdmin(false);
    navigate('/');
  }

  return (
    <header>
      <Link to="/" className="brand">
        Exec<span>Flow</span>
      </Link>
      <nav aria-label="Primary navigation">
        <Link to="/problems">Problems</Link>
        <Link to="/contests">Contests</Link>
        {isAuthenticated ? (
          <>
            <Link to="/status">Worker status</Link>
            {isAdmin && <Link to="/admin/contests/new">Create contest</Link>}
            <Link to="/submissions">My submissions</Link>
            <button className="nav-action" onClick={logOut}>
              Log out
            </button>
          </>
        ) : (
          <>
            <Link to="/status">Worker status</Link>
            <Link to="/login">Log in</Link>
            <Link className="button small" to="/register">
              Get started
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}

export default function App() {
  return (
    <>
      <SiteHeader />
      <main>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/problems" element={<ProblemsPage />} />
          <Route path="/problems/:id" element={<ProblemDetailsPage />} />
          <Route path="/contests" element={<ContestsPage />} />
          <Route path="/contests/:id" element={<ContestDetailsPage />} />
          <Route path="/admin/contests/new" element={<AdminContestCreatePage />} />
          <Route path="/submissions" element={<SubmissionsPage />} />
          <Route path="/submissions/:id" element={<SubmissionDetailsPage />} />
          <Route path="/status" element={<WorkerStatusPage />} />
        </Routes>
      </main>
    </>
  );
}
