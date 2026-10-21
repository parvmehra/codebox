import { useMutation, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ProblemSummary } from '../services/api';

type CreateContestResponse = {
  data: { slug: string };
};

type ApiError = { error?: { message?: string } };

function localDateTime(hoursFromNow: number) {
  const date = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function AdminContestCreatePage() {
  const navigate = useNavigate();
  const [selectedProblems, setSelectedProblems] = useState<Record<string, number>>({});
  const problemsQuery = useQuery({
    queryKey: ['problems'],
    queryFn: async () => (await api.get<{ data: ProblemSummary[] }>('/problems')).data.data,
  });
  const createContest = useMutation({
    mutationFn: async (payload: {
      slug: string;
      title: string;
      description: string;
      startAt: string;
      endAt: string;
      isPublished: boolean;
      problems: { problemId: string; points: number }[];
    }) => (await api.post<CreateContestResponse>('/contests', payload)).data.data,
    onSuccess: (contest) => navigate(`/contests/${contest.slug}`),
  });

  if (!localStorage.getItem('token')) {
    return (
      <section className="page-state">
        <p>Log in with an administrator account to create a contest.</p>
        <Link className="button" to="/login">
          Log in
        </Link>
      </section>
    );
  }

  const requestError = axios.isAxiosError<ApiError>(createContest.error)
    ? createContest.error.response?.data?.error?.message
    : undefined;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const problems = Object.entries(selectedProblems).map(([problemId, points]) => ({
      problemId,
      points,
    }));
    createContest.mutate({
      slug: String(form.get('slug')).trim(),
      title: String(form.get('title')).trim(),
      description: String(form.get('description')).trim(),
      startAt: new Date(String(form.get('startAt'))).toISOString(),
      endAt: new Date(String(form.get('endAt'))).toISOString(),
      isPublished: true,
      problems,
    });
  }

  return (
    <section className="admin-contest-page">
      <Link className="text-link" to="/contests">
        ← All contests
      </Link>
      <div className="page-heading">
        <p className="eyebrow">ADMIN · CONTEST SETUP</p>
        <h1>Define the event.</h1>
        <p>Choose published problems, set their point values, and schedule the contest window.</p>
      </div>

      <form className="admin-contest-form" onSubmit={handleSubmit}>
        <div className="admin-contest-fields">
          <label>
            Contest title
            <input name="title" minLength={3} maxLength={160} required />
          </label>
          <label>
            URL slug
            <input name="slug" pattern="[a-z0-9-]+" maxLength={120} required />
          </label>
          <label className="admin-contest-description">
            Description
            <textarea name="description" maxLength={4000} rows={4} required />
          </label>
          <label>
            Starts
            <input name="startAt" type="datetime-local" defaultValue={localDateTime(1)} required />
          </label>
          <label>
            Ends
            <input name="endAt" type="datetime-local" defaultValue={localDateTime(3)} required />
          </label>
        </div>

        <div className="contest-selection">
          <div className="section-heading">
            <div>
              <p className="eyebrow">PROBLEM SET</p>
              <h2>Select published problems</h2>
            </div>
            <span className="muted">{Object.keys(selectedProblems).length} selected</span>
          </div>
          {problemsQuery.isPending && <p className="muted">Loading problems…</p>}
          {problemsQuery.isError && (
            <p className="error">Published problems could not be loaded.</p>
          )}
          {problemsQuery.data?.length === 0 && (
            <p className="muted">Publish problems before creating a contest.</p>
          )}
          {problemsQuery.data?.map((problem) => {
            const isSelected = problem.id in selectedProblems;
            return (
              <div className="admin-contest-problem" key={problem.id}>
                <label className="admin-contest-problem-select">
                  <input
                    checked={isSelected}
                    onChange={(event) =>
                      setSelectedProblems((current) => {
                        const next = { ...current };
                        if (event.target.checked) next[problem.id] = 100;
                        else delete next[problem.id];
                        return next;
                      })
                    }
                    type="checkbox"
                  />
                  <span>
                    <strong>{problem.title}</strong>
                    <small>{problem.difficulty}</small>
                  </span>
                </label>
                {isSelected && (
                  <label className="contest-points-input">
                    Points
                    <input
                      min={1}
                      max={10000}
                      onChange={(event) =>
                        setSelectedProblems((current) => ({
                          ...current,
                          [problem.id]: Number(event.target.value),
                        }))
                      }
                      type="number"
                      value={selectedProblems[problem.id]}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>

        {requestError && (
          <p className="error" role="alert">
            {requestError}
          </p>
        )}
        <button
          className="button"
          disabled={createContest.isPending || Object.keys(selectedProblems).length === 0}
        >
          {createContest.isPending ? 'Saving…' : 'Create contest'}
        </button>
      </form>
    </section>
  );
}
