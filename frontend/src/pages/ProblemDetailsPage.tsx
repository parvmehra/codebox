import axios from 'axios';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { api, type Problem, type QueuedSubmission, type SubmissionLanguage } from '../services/api';

const starterCode: Record<SubmissionLanguage, string> = {
  JAVA: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        // Read input and print your answer.
    }
}`,
  PYTHON: `def solve():
    # Read input and print your answer.
    pass


if __name__ == "__main__":
    solve()`,
  CPP: `#include <iostream>
using namespace std;

int main() {
    // Read input and print your answer.
    return 0;
}`,
  NODEJS: `const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');

// Read input and print your answer.
console.log(input.trim());`,
};

type SubmissionApiError = { error?: { message?: string }; submissionId?: string };

const monacoLanguage: Record<SubmissionLanguage, string> = {
  JAVA: 'java',
  PYTHON: 'python',
  CPP: 'cpp',
  NODEJS: 'javascript',
};

export function ProblemDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [language, setLanguage] = useState<SubmissionLanguage>('JAVA');
  const [sourceCode, setSourceCode] = useState(starterCode.JAVA);
  const { data, isPending, isError } = useQuery({
    queryKey: ['problem', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get<{ data: Problem }>(`/problems/${id}`)).data.data,
  });
  const submit = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ data: QueuedSubmission }>('/submissions', {
          problemId: id,
          language,
          sourceCode,
        })
      ).data.data,
    onSuccess: (submission) => navigate(`/submissions/${submission.id}`),
  });

  if (isPending) return <p className="page-state">Loading problem…</p>;
  if (isError || !data) return <p className="error page-state">Problem not found.</p>;

  const errorBody = axios.isAxiosError<SubmissionApiError>(submit.error)
    ? submit.error.response?.data
    : undefined;
  const isAuthenticated = Boolean(localStorage.getItem('token'));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit.mutate();
  }

  function changeLanguage(nextLanguage: SubmissionLanguage) {
    setSourceCode((current) =>
      current === starterCode[language] ? starterCode[nextLanguage] : current,
    );
    setLanguage(nextLanguage);
  }

  return (
    <section className="problem-detail">
      <Link className="text-link" to="/problems">
        ← All problems
      </Link>
      <div className="detail-title">
        <div>
          <span className={`badge ${data.difficulty.toLowerCase()}`}>{data.difficulty}</span>
          <h1>{data.title}</h1>
        </div>
      </div>

      <div className="submission-workspace">
        <article className="problem-copy">
          <h2>Description</h2>
          <p>{data.description}</p>
          <h2>Constraints</h2>
          <p>{data.constraints}</p>
          <h2>Input format</h2>
          <p>{data.inputFormat}</p>
          <h2>Output format</h2>
          <p>{data.outputFormat}</p>
          <h2>Examples</h2>
          {data.examples.map((example, index) => (
            <pre key={index}>
              Input: {example.input}
              {'\n'}Output: {example.output}
              {example.explanation ? `\nExplanation: ${example.explanation}` : ''}
            </pre>
          ))}
        </article>

        <aside className="submission-panel">
          <div className="editor-heading">
            <div>
              <p className="eyebrow">YOUR SOLUTION</p>
              <h2>Submit code</h2>
            </div>
            <span className="editor-language">{language}</span>
          </div>
          {isAuthenticated ? (
            <form className="submission-form" onSubmit={handleSubmit}>
              <label className="language-picker">
                Language
                <select
                  value={language}
                  onChange={(event) => changeLanguage(event.target.value as SubmissionLanguage)}
                >
                  <option value="JAVA">Java 21</option>
                  <option value="PYTHON">Python 3.12</option>
                  <option value="CPP">C++23</option>
                  <option value="NODEJS">Node.js 22</option>
                </select>
              </label>
              <div className="code-editor min-w-0" role="region" aria-label="Source code editor">
                <Editor
                  height="100%"
                  language={monacoLanguage[language]}
                  value={sourceCode}
                  onChange={(value) => setSourceCode(value ?? '')}
                  theme="vs-dark"
                  loading="Loading editor…"
                  options={{
                    automaticLayout: true,
                    fontSize: 13,
                    insertSpaces: true,
                    lineNumbers: 'on',
                    minimap: { enabled: false },
                    padding: { top: 12, bottom: 12 },
                    scrollBeyondLastLine: false,
                    tabSize: 4,
                    wordWrap: 'on',
                  }}
                />
              </div>
              {submit.isError && (
                <p className="error submit-error">
                  {errorBody?.error?.message ?? 'Could not submit this solution. Please try again.'}
                  {errorBody?.submissionId && (
                    <>
                      {' '}
                      <Link to={`/submissions/${errorBody.submissionId}`}>View its status</Link>.
                    </>
                  )}
                </p>
              )}
              <div className="editor-footer">
                <span>Up to 100,000 characters</span>
                <button className="button" disabled={submit.isPending || !sourceCode.trim()}>
                  {submit.isPending ? 'Sending…' : 'Submit solution'}
                </button>
              </div>
            </form>
          ) : (
            <div className="auth-notice">
              <p>Log in to submit a solution and follow its status.</p>
              <Link className="button" to="/login">
                Log in to submit
              </Link>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
