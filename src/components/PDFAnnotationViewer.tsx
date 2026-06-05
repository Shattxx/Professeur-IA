import React, { useState, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { max, min } from 'mathjs';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { 
  MessageSquare, 
  Highlighter, 
  X, 
  Save, 
  ChevronLeft, 
  ChevronRight,
  Plus,
  Trash2
} from 'lucide-react';
import { cn } from '../lib/utils';

// Set worker path for pdfjs
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface Annotation {
  id: number;
  documentId: string;
  type: 'highlight' | 'comment';
  content: string;
  page: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color: string;
}

interface PDFAnnotationViewerProps {
  documentPath: string;
  documentName: string;
  onClose: () => void;
}

export function PDFAnnotationViewer({ documentPath, documentName, onClose }: PDFAnnotationViewerProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [isAddingComment, setIsAddingComment] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [commentPos, setCommentPos] = useState<{ x: number, y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAnnotations();
  }, [documentName]);

  const fetchAnnotations = async () => {
    try {
      const res = await fetch(`/api/annotations?documentId=${encodeURIComponent(documentName)}`);
      const data = await res.json();
      setAnnotations(data.annotations || []);
    } catch (e) {
      console.error("Failed to fetch annotations", e);
    }
  };

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
  }

  const handlePageClick = (e: React.MouseEvent) => {
    if (!isAddingComment) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    setCommentPos({ x, y });
  };

  const saveComment = async () => {
    if (!commentPos || !newComment.trim()) return;

    const annotation: Partial<Annotation> = {
      type: 'comment',
      content: newComment,
      page: pageNumber,
      x: commentPos.x,
      y: commentPos.y,
      color: '#FCD34D' // yellow
    };

    try {
      const res = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: documentName, annotation })
      });
      if (res.ok) {
        setNewComment('');
        setCommentPos(null);
        setIsAddingComment(false);
        fetchAnnotations();
      }
    } catch (e) {
      console.error("Failed to save annotation", e);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-4">
      <div className="bg-white w-full max-w-5xl h-[90vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-white sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center text-indigo-600">
              <FileText size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900 line-clamp-1">{documentName}</h2>
              <p className="text-xs text-gray-500">Page {pageNumber} sur {numPages || '...'}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button 
              onClick={() => setIsAddingComment(!isAddingComment)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all",
                isAddingComment ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              )}
            >
              <MessageSquare size={16} />
              <span>{isAddingComment ? "Clique sur la page" : "Ajouter un commentaire"}</span>
            </button>
            <div className="h-8 w-px bg-gray-200 mx-2" />
            <button 
              onClick={onClose}
              className="p-2 hover:bg-gray-100 rounded-full transition-colors text-gray-400 hover:text-gray-600"
            >
              <X size={24} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden bg-gray-100">
          {/* PDF Viewer */}
          <div className="flex-1 overflow-auto p-8 flex justify-center relative" ref={containerRef}>
            <div className="relative shadow-2xl bg-white">
              <Document
                file={`/api/documents/view?filePath=${encodeURIComponent(documentPath)}`}
                onLoadSuccess={onDocumentLoadSuccess}
                loading={
                  <div className="flex flex-col items-center justify-center p-20">
                    <Loader2 className="animate-spin text-indigo-600 mb-4" size={40} />
                    <p className="text-gray-500 font-medium">Chargement du manuel...</p>
                  </div>
                }
              >
                <div className="relative" onClick={handlePageClick}>
                  <Page 
                    pageNumber={pageNumber} 
                    renderAnnotationLayer={false}
                    renderTextLayer={true}
                    width={800}
                  />
                  
                  {/* Annotations Overlay */}
                  {annotations
                    .filter(ann => ann.page === pageNumber)
                    .map(ann => (
                      <div 
                        key={ann.id}
                        className="absolute group cursor-pointer"
                        style={{
                          left: `${ann.x}%`,
                          top: `${ann.y}%`,
                          transform: 'translate(-50%, -50%)'
                        }}
                      >
                        <div className="w-6 h-6 bg-amber-400 rounded-full flex items-center justify-center text-white shadow-lg border-2 border-white">
                          <MessageSquare size={12} />
                        </div>
                        
                        {/* Tooltip/Popup */}
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-white p-3 rounded-xl shadow-xl border border-gray-100 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-30">
                          <p className="text-xs text-gray-700 leading-relaxed">{ann.content}</p>
                        </div>
                      </div>
                    ))
                  }

                  {/* New Comment Marker */}
                  {commentPos && (
                    <div 
                      className="absolute z-40"
                      style={{
                        left: `${commentPos.x}%`,
                        top: `${commentPos.y}%`,
                        transform: 'translate(-50%, -50%)'
                      }}
                    >
                      <div className="w-6 h-6 bg-indigo-600 rounded-full animate-bounce shadow-lg border-2 border-white" />
                    </div>
                  )}
                </div>
              </Document>
            </div>
          </div>

          {/* Sidebar for Comments */}
          <div className="w-80 bg-white border-l border-gray-100 flex flex-col p-6 overflow-y-auto">
            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-6">Commentaires</h3>
            
            {isAddingComment && commentPos && (
              <div className="mb-6 p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                <textarea 
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Écris ton commentaire ici..."
                  className="w-full bg-transparent border-none focus:ring-0 text-sm text-gray-700 resize-none h-24"
                  autoFocus
                />
                <div className="flex justify-end gap-2 mt-2">
                  <button 
                    onClick={() => { setCommentPos(null); setNewComment(''); }}
                    className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700"
                  >
                    Annuler
                  </button>
                  <button 
                    onClick={saveComment}
                    className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-lg shadow-md shadow-indigo-100"
                  >
                    Enregistrer
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-4">
              {annotations.length === 0 ? (
                <div className="text-center py-12">
                  <MessageSquare size={32} className="mx-auto text-gray-200 mb-2" />
                  <p className="text-xs text-gray-400">Aucun commentaire sur ce manuel.</p>
                </div>
              ) : (
                annotations.map(ann => (
                  <div key={ann.id} className="p-4 bg-gray-50 rounded-2xl border border-gray-100 hover:border-indigo-200 transition-colors">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold text-indigo-400 uppercase">Page {ann.page}</span>
                      <button className="text-gray-300 hover:text-red-500 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <p className="text-sm text-gray-700 leading-relaxed">{ann.content}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Footer Controls */}
        <div className="p-4 border-t border-gray-100 bg-white flex items-center justify-center gap-6">
          <button 
            onClick={() => setPageNumber(Number(max(1, pageNumber - 1)))}
            disabled={pageNumber <= 1}
            className="p-2 rounded-xl hover:bg-gray-100 disabled:opacity-30 transition-all"
          >
            <ChevronLeft size={24} />
          </button>
          
          <div className="flex items-center gap-2">
            <input 
              type="number" 
              value={pageNumber}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (val >= 1 && val <= (numPages || 1)) setPageNumber(val);
              }}
              className="w-12 text-center font-bold text-indigo-600 bg-indigo-50 border-none rounded-lg py-1 focus:ring-2 focus:ring-indigo-500"
            />
            <span className="text-gray-400 font-medium">/ {numPages || '...'}</span>
          </div>

          <button 
            onClick={() => setPageNumber(Number(min(numPages || 1, pageNumber + 1)))}
            disabled={pageNumber >= (numPages || 1)}
            className="p-2 rounded-xl hover:bg-gray-100 disabled:opacity-30 transition-all"
          >
            <ChevronRight size={24} />
          </button>
        </div>
      </div>
    </div>
  );
}

function FileText({ size }: { size: number }) {
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

function Loader2({ className, size }: { className?: string, size: number }) {
  return (
    <svg 
      className={cn("animate-spin", className)}
      width={size} 
      height={size} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
