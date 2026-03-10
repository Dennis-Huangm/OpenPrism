import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  transferStart,
  transferStep,
  transferSubmitImages,
  mineruTransferStart,
  mineruTransferUploadPdf,
  listTemplates,
  listTemplateFiles,
  getProjectTree,
} from '../api/client';
import type {
  LLMConfig,
  TemplateMeta,
  FileItem,
} from '../api/client';

interface TransferPanelProps {
  projectId: string;
  onJobUpdate?: (job: { jobId: string; status: string; progressLog: string[]; error?: string }) => void;
}

type TransferMode = 'legacy' | 'mineru';
type MineruSource = 'project' | 'upload';

const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk'] as const;

export default function TransferPanel({ projectId, onJobUpdate }: TransferPanelProps) {
  const { t } = useTranslation();

  // Transfer mode
  const [transferMode, setTransferMode] = useState<TransferMode>('mineru');
  const [mineruSource, setMineruSource] = useState<MineruSource>('project');
  const [uploadedPdf, setUploadedPdf] = useState<File | null>(null);

  // Source file selection
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [sourceMainFile, setSourceMainFile] = useState('');
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);

  // Target selection
  const [targetTemplateId, setTargetTemplateId] = useState('');
  const [targetTemplateFiles, setTargetTemplateFiles] = useState<string[]>([]);
  const [targetMainFile, setTargetMainFile] = useState('');
  const [targetFileDropdownOpen, setTargetFileDropdownOpen] = useState(false);
  const [targetFilesError, setTargetFilesError] = useState('');
  const [engine, setEngine] = useState('pdflatex');
  const [layoutCheck, setLayoutCheck] = useState(false);

  // LLM config — read from shared localStorage (set via ProjectPage / EditorPage settings)
  const SETTINGS_KEY = 'openprism-settings-v1';
  const readLLMFromStorage = (): { llmEndpoint: string; llmApiKey: string; llmModel: string } => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { llmEndpoint: '', llmApiKey: '', llmModel: '' };
      const p = JSON.parse(raw);
      return { llmEndpoint: p.llmEndpoint || '', llmApiKey: p.llmApiKey || '', llmModel: p.llmModel || '' };
    } catch { return { llmEndpoint: '', llmApiKey: '', llmModel: '' }; }
  };

  const [mineruToken, setMineruToken] = useState('');

  // Dropdown open states
  const [templateDropdownOpen, setTemplateDropdownOpen] = useState(false);
  const [engineDropdownOpen, setEngineDropdownOpen] = useState(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);

  // Job state
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState<string>('idle');
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  // Template list for target selection
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

  // Refs for click-outside
  const sourceRef = useRef<HTMLDivElement>(null);
  const templateRef = useRef<HTMLDivElement>(null);
  const targetFileRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  // Load source .tex files on mount
  useEffect(() => {
    getProjectTree(projectId)
      .then(res => {
        const texFiles = (res.items || [])
          .filter(f => f.type === 'file' && f.path.endsWith('.tex'))
          .map(f => f.path);
        setSourceFiles(texFiles);
        if (texFiles.length > 0) {
          const configuredMain = res.mainFile && texFiles.includes(res.mainFile) ? res.mainFile : '';
          const main = configuredMain || texFiles.find(f => f === 'main.tex' || f.endsWith('/main.tex'));
          setSourceMainFile(main || texFiles[0]);
        }
      })
      .catch(() => {});
  }, [projectId]);

  // Load templates on mount
  useEffect(() => {
    if (!templatesLoaded) {
      listTemplates()
        .then(res => {
          setTemplates(res.templates || []);
          setTemplatesLoaded(true);
        })
        .catch(() => {});
    }
  }, [templatesLoaded]);

  useEffect(() => {
    if (!targetTemplateId) {
      setTargetTemplateFiles([]);
      setTargetMainFile('');
      setTargetFilesError('');
      return;
    }

    setTargetFilesError('');

    let cancelled = false;
    listTemplateFiles(targetTemplateId)
      .then((res) => {
        if (cancelled) return;
        const files = (res.files || []).slice().sort((a, b) => a.localeCompare(b));
        setTargetTemplateFiles(files);
        const selectedTemplate = templates.find((item) => item.id === targetTemplateId);
        const preferred = selectedTemplate?.mainFile || '';
        const fallback = files[0] || preferred;
        setTargetMainFile(() => {
          if (preferred && files.includes(preferred)) return preferred;
          return fallback;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setTargetTemplateFiles([]);
        setTargetMainFile('');
        setTargetFilesError(t('无法加载该模板的主文件列表'));
      });

    return () => {
      cancelled = true;
    };
  }, [targetTemplateId, templates]);

  // Click outside to close dropdowns
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sourceRef.current && !sourceRef.current.contains(e.target as Node)) setSourceDropdownOpen(false);
      if (templateRef.current && !templateRef.current.contains(e.target as Node)) setTemplateDropdownOpen(false);
      if (targetFileRef.current && !targetFileRef.current.contains(e.target as Node)) setTargetFileDropdownOpen(false);
      if (engineRef.current && !engineRef.current.contains(e.target as Node)) setEngineDropdownOpen(false);
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) setModeDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedTemplateName = templates.find(tp => tp.id === targetTemplateId)?.label || '';
  const selectedTemplate = templates.find(tp => tp.id === targetTemplateId);

  const buildLlmConfig = (): Partial<LLMConfig> | undefined => {
    const { llmEndpoint, llmApiKey, llmModel } = readLLMFromStorage();
    if (!llmEndpoint && !llmApiKey && !llmModel) return undefined;
    return {
      ...(llmEndpoint ? { endpoint: llmEndpoint } : {}),
      ...(llmApiKey ? { apiKey: llmApiKey } : {}),
      ...(llmModel ? { model: llmModel } : {}),
    };
  };

  const handleStart = useCallback(async () => {
    if (!targetTemplateId || !targetMainFile) return;
    setError('');
    setProgressLog([]);
    setRunning(true);
    setStatus('starting');

    try {
      if (transferMode === 'mineru') {
        const mineruConfig = mineruToken
          ? { token: mineruToken }
          : undefined;

        const res = await mineruTransferStart({
          sourceProjectId: mineruSource === 'project' ? projectId : undefined,
          sourceMainFile: mineruSource === 'project' ? sourceMainFile : undefined,
          targetTemplateId,
          targetMainFile,
          engine,
          layoutCheck,
          llmConfig: buildLlmConfig(),
          mineruConfig,
        });
        setJobId(res.jobId);

        // If uploading PDF, upload it before running graph
        if (mineruSource === 'upload' && uploadedPdf) {
          setStatus('uploading_pdf');
          await mineruTransferUploadPdf(res.jobId, uploadedPdf);
        }

        setStatus('started');
        await runGraph(res.jobId);
      } else {
        // Legacy mode
        if (!sourceMainFile) return;
        const res = await transferStart({
          sourceProjectId: projectId,
          sourceMainFile,
          targetTemplateId,
          targetMainFile,
          engine,
          layoutCheck,
          llmConfig: buildLlmConfig(),
        });
        setJobId(res.jobId);
        setStatus('started');
        await runGraph(res.jobId);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start transfer');
      setRunning(false);
      setStatus('error');
    }
  }, [transferMode, mineruSource, uploadedPdf, targetTemplateId, targetMainFile, sourceMainFile, projectId, engine, layoutCheck, selectedTemplate, mineruToken]);

  const runGraph = useCallback(async (jid: string) => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await transferStep(jid);
        setProgressLog(res.progressLog || []);
        setStatus(res.status);
        onJobUpdate?.({ jobId: jid, status: res.status, progressLog: res.progressLog || [], error: res.error });

        if (res.status === 'waiting_images') { setRunning(false); return; }
        if (res.status === 'success' || res.status === 'failed') { setRunning(false); return; }
        if (res.error) { setError(res.error); setRunning(false); return; }

        // Brief pause before next poll
        await new Promise(r => setTimeout(r, 1000));
      } catch (err: any) {
        setError(err.message || 'Step failed');
        setRunning(false);
        setStatus('error');
        onJobUpdate?.({ jobId: jid, status: 'error', progressLog: [], error: err.message });
        return;
      }
    }
  }, [onJobUpdate]);

  const chevronSvg = (open: boolean) => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={open ? 'rotate' : ''}>
      <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  const checkSvg = (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  const modeLabel = transferMode === 'mineru' ? 'MinerU (PDF→MD→LaTeX)' : t('经典模式 (LaTeX→LaTeX)');

  const canStart = (() => {
    if (running || !targetTemplateId || !targetMainFile) return false;
    if (transferMode === 'legacy') return !!sourceMainFile;
    if (transferMode === 'mineru') {
      if (mineruSource === 'project') return !!sourceMainFile;
      if (mineruSource === 'upload') return !!uploadedPdf;
    }
    return false;
  })();

  return (
    <div className="transfer-panel">
      {/* Transfer mode selection */}
      <div className="field">
        <label>{t('转换模式')}</label>
        <div className="ios-select-wrapper" ref={modeRef}>
          <button className="ios-select-trigger" onClick={() => setModeDropdownOpen(!modeDropdownOpen)}>
            <span>{modeLabel}</span>
            {chevronSvg(modeDropdownOpen)}
          </button>
          {modeDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              <div
                className={`ios-dropdown-item ${transferMode === 'mineru' ? 'active' : ''}`}
                onClick={() => { setTransferMode('mineru'); setModeDropdownOpen(false); }}
              >
                MinerU (PDF→MD→LaTeX)
                {transferMode === 'mineru' && checkSvg}
              </div>
              <div
                className={`ios-dropdown-item ${transferMode === 'legacy' ? 'active' : ''}`}
                onClick={() => { setTransferMode('legacy'); setModeDropdownOpen(false); }}
              >
                {t('经典模式 (LaTeX→LaTeX)')}
                {transferMode === 'legacy' && checkSvg}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* MinerU mode: source selection (project or upload) */}
      {transferMode === 'mineru' && (
        <div className="field">
          <label>{t('输入来源')}</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button
              className={`btn ${mineruSource === 'project' ? 'primary' : ''}`}
              style={{ flex: 1, fontSize: 12 }}
              onClick={() => setMineruSource('project')}
            >
              {t('从当前项目编译')}
            </button>
            <button
              className={`btn ${mineruSource === 'upload' ? 'primary' : ''}`}
              style={{ flex: 1, fontSize: 12 }}
              onClick={() => setMineruSource('upload')}
            >
              {t('上传 PDF')}
            </button>
          </div>
        </div>
      )}

      {/* Source file selection — shown for legacy mode or MinerU project mode */}
      {(transferMode === 'legacy' || (transferMode === 'mineru' && mineruSource === 'project')) && (
        <div className="field">
          <label>{t('源文件')}</label>
          <div className="ios-select-wrapper" ref={sourceRef}>
            <button className="ios-select-trigger" onClick={() => setSourceDropdownOpen(!sourceDropdownOpen)}>
              <span>{sourceMainFile || t('选择源文件...')}</span>
              {chevronSvg(sourceDropdownOpen)}
            </button>
            {sourceDropdownOpen && (
              <div className="ios-dropdown dropdown-down">
                {sourceFiles.map(f => (
                  <div
                    key={f}
                    className={`ios-dropdown-item ${sourceMainFile === f ? 'active' : ''}`}
                    onClick={() => { setSourceMainFile(f); setSourceDropdownOpen(false); }}
                  >
                    {f}
                    {sourceMainFile === f && checkSvg}
                  </div>
                ))}
                {sourceFiles.length === 0 && (
                  <div className="ios-dropdown-item" style={{ color: 'var(--muted)', pointerEvents: 'none' }}>
                    {t('未找到 .tex 文件')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* PDF upload — shown for MinerU upload mode */}
      {transferMode === 'mineru' && mineruSource === 'upload' && (
        <div className="field">
          <label>{t('上传 PDF 文件')}</label>
          <input
            ref={pdfInputRef}
            type="file"
            accept=".pdf"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) setUploadedPdf(file);
            }}
          />
          <button
            className="btn"
            style={{ width: '100%', fontSize: 12, marginBottom: 4 }}
            onClick={() => pdfInputRef.current?.click()}
          >
            {uploadedPdf ? uploadedPdf.name : t('选择 PDF 文件...')}
          </button>
        </div>
      )}

      {/* Target template selection */}
      <div className="field">
        <label>{t('目标模板')}</label>
        <div className="ios-select-wrapper" ref={templateRef}>
          <button className="ios-select-trigger" onClick={() => setTemplateDropdownOpen(!templateDropdownOpen)}>
            <span>{selectedTemplateName || t('选择目标模板...')}</span>
            {chevronSvg(templateDropdownOpen)}
          </button>
          {templateDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              {templates.map(tmpl => (
                <div
                  key={tmpl.id}
                  className={`ios-dropdown-item ${targetTemplateId === tmpl.id ? 'active' : ''}`}
                  onClick={() => { setTargetTemplateId(tmpl.id); setTemplateDropdownOpen(false); }}
                >
                  {tmpl.label}
                  {targetTemplateId === tmpl.id && checkSvg}
                </div>
              ))}
              {templates.length === 0 && (
                <div className="ios-dropdown-item" style={{ color: 'var(--muted)', pointerEvents: 'none' }}>
                  {t('暂无可选模板')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Target main file selection */}
      <div className="field">
        <label>{t('目标主文件')}</label>
        <div className="ios-select-wrapper" ref={targetFileRef}>
          <button className="ios-select-trigger" onClick={() => setTargetFileDropdownOpen(!targetFileDropdownOpen)} disabled={!targetTemplateId || !!targetFilesError}>
            <span>{targetMainFile || t('选择目标主文件...')}</span>
            {chevronSvg(targetFileDropdownOpen)}
          </button>
          {targetFileDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              {targetTemplateFiles.map((file) => (
                <div
                  key={file}
                  className={`ios-dropdown-item ${targetMainFile === file ? 'active' : ''}`}
                  onClick={() => { setTargetMainFile(file); setTargetFileDropdownOpen(false); }}
                >
                  {file}
                  {targetMainFile === file && checkSvg}
                </div>
              ))}
              {targetTemplateFiles.length === 0 && (
                <div className="ios-dropdown-item" style={{ color: 'var(--muted)', pointerEvents: 'none' }}>
                  {t('未找到 .tex 文件')}
                </div>
              )}
            </div>
          )}
        </div>
        {targetFilesError && (
          <div style={{ fontSize: 12, color: '#d32f2f', marginTop: 6 }}>{targetFilesError}</div>
        )}
      </div>

      {/* Engine selection */}
      <div className="field">
        <label>{t('编译引擎')}</label>
        <div className="ios-select-wrapper" ref={engineRef}>
          <button className="ios-select-trigger" onClick={() => setEngineDropdownOpen(!engineDropdownOpen)}>
            <span>{engine}</span>
            {chevronSvg(engineDropdownOpen)}
          </button>
          {engineDropdownOpen && (
            <div className="ios-dropdown dropdown-down">
              {ENGINES.map(eng => (
                <div
                  key={eng}
                  className={`ios-dropdown-item ${engine === eng ? 'active' : ''}`}
                  onClick={() => { setEngine(eng); setEngineDropdownOpen(false); }}
                >
                  {eng}
                  {engine === eng && checkSvg}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Layout check toggle */}
      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, opacity: 0.6 }}>
        <input type="checkbox" checked={layoutCheck} disabled onChange={e => setLayoutCheck(e.target.checked)} />
        {t('启用排版检查 (VLM)')} {t('(即将支持)')}
      </label>

      {/* MinerU token — shown only in MinerU mode */}
      {transferMode === 'mineru' && (
        <div style={{ marginBottom: 12 }}>
          <div className="field">
            <label>MinerU Token</label>
            <div className="ios-select-wrapper">
              <input
                type="password"
                className="ios-select-trigger"
                placeholder={t('输入 MinerU API Token...')}
                value={mineruToken}
                onChange={e => setMineruToken(e.target.value)}
                style={{ paddingRight: 12 }}
              />
            </div>
          </div>
        </div>
      )}

      {/* LLM Config — managed in header settings */}

      {/* Start button */}
      <button
        className="btn primary"
        style={{ width: '100%', marginBottom: 12 }}
        disabled={!canStart}
        onClick={handleStart}
      >
        {running ? t('转换中...') : t('开始转换')}
      </button>

      {/* Status */}
      {status !== 'idle' && (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          <strong>{t('状态')}:</strong> {status}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ fontSize: 12, color: '#d32f2f', marginBottom: 8 }}>{error}</div>
      )}

      {/* Progress log */}
      {progressLog.length > 0 && (
        <div style={{
          fontSize: 11, fontFamily: 'monospace',
          background: 'rgba(120, 98, 83, 0.06)', borderRadius: 8,
          padding: 8, maxHeight: 300, overflowY: 'auto' as const,
        }}>
          {progressLog.map((line, i) => (
            <div key={i} style={{ marginBottom: 2 }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
