import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { ProblemDetailsPage } from './pages/ProblemDetailsPage';
import { ProblemsPage } from './pages/ProblemsPage';
import { RegisterPage } from './pages/RegisterPage';
import { SubmissionDetailsPage } from './pages/SubmissionDetailsPage';
import { SubmissionsPage } from './pages/SubmissionsPage';

function SiteHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isAuthenticated, setIsAuthenticated] = useState(() => Boolean(localStorage.getItem('token')));

  useEffect(() => {
    setIsAuthenticated(Boolean(localStorage.getItem('token')));
  }, [location.pathname]);

  function logOut() {
    localStorage.removeItem('token');
    setIsAuthenticated(false);
    navigate('/');
  }

  return (
    <header>
      <Link to="/" className="brand">Exec<span>Flow</span></Link>
      <nav aria-label="Primary navigation">
        <Link to="/problems">Problems</Link>
        {isAuthenticated ? (
          <>
            <Link to="/submissions">My submissions</Link>
            <button className="nav-action" onClick={logOut}>Log out</button>
          </>
        ) : (
          <>
            <Link to="/login">Log in</Link>
            <Link className="button small" to="/register">Get started</Link>
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
          <Route path="/submissions" element={<SubmissionsPage />} />
          <Route path="/submissions/:id" element={<SubmissionDetailsPage />} />
        </Routes>
      </main>
    </>
  );
}
