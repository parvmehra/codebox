import { Link, Route, Routes } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { ProblemsPage } from './pages/ProblemsPage';
import { ProblemDetailsPage } from './pages/ProblemDetailsPage';
import { RegisterPage } from './pages/RegisterPage';
export default function App() { return <><header><Link to="/" className="brand">Exec<span>Flow</span></Link><nav><Link to="/problems">Problems</Link><Link to="/login">Log in</Link><Link className="button small" to="/register">Get started</Link></nav></header><main><Routes><Route path="/" element={<LandingPage />} /><Route path="/login" element={<LoginPage />} /><Route path="/register" element={<RegisterPage />} /><Route path="/problems" element={<ProblemsPage />} /><Route path="/problems/:id" element={<ProblemDetailsPage />} /></Routes></main></> }
