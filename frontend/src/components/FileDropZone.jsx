import { FileCheck2, UploadCloud } from 'lucide-react'
import { useRef, useState } from 'react'

// A dashed drop zone in place of a bare <input type="file">.
//
// The input itself is still here, still labelled, and still the thing that
// holds the file -- it is only moved out of sight (visually-hidden, not
// display:none, so it keeps its place in the accessibility tree and a test
// can still set files on it). Everything visible is chrome around it:
// clicking Browse forwards to the input, and a drop writes the dropped file
// onto the input through a DataTransfer so `input.files` is the single
// source of truth either way.

/** What the server actually accepts -- see TaskAttachmentSerializer. */
export const ATTACHMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.webp,.docx'
export const ATTACHMENT_HINT = 'PDF, JPEG, PNG, GIF, WebP or DOCX — up to 15 MB'

export default function FileDropZone({
  /** The input's accessible name. */
  label,
  id,
  accept = ATTACHMENT_ACCEPT,
  hint = ATTACHMENT_HINT,
  file,
  onFileChange,
  disabled = false,
  required = false,
}) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  function handleFiles(files) {
    const [first] = files ?? []
    if (first) {
      onFileChange(first)
    }
  }

  function handleDrop(event) {
    event.preventDefault()
    setDragging(false)
    if (disabled) {
      return
    }
    // Writing the drop onto the input keeps `input.files` authoritative --
    // otherwise a dropped file and a browsed one would live in two
    // different places, and form validation would only see one of them.
    if (inputRef.current && event.dataTransfer?.files?.length) {
      inputRef.current.files = event.dataTransfer.files
    }
    handleFiles(event.dataTransfer?.files)
  }

  return (
    <div
      className={`dropzone ${dragging ? 'dropzone--active' : ''} ${disabled ? 'dropzone--disabled' : ''}`.trim()}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        id={id}
        className="visually-hidden"
        aria-label={label}
        accept={accept}
        disabled={disabled}
        required={required}
        onChange={(event) => handleFiles(event.target.files)}
      />

      {file ? (
        <>
          <FileCheck2 size={28} className="dropzone__icon" aria-hidden="true" />
          <p className="dropzone__title">{file.name}</p>
          <p className="dropzone__hint">{formatBytes(file.size)}</p>
        </>
      ) : (
        <>
          <UploadCloud size={28} className="dropzone__icon" aria-hidden="true" />
          <p className="dropzone__title">Choose a file or drag and drop it here</p>
          <p className="dropzone__hint">{hint}</p>
        </>
      )}

      <button
        type="button"
        className="btn btn-outline-secondary btn-sm"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {file ? 'Choose another file' : 'Browse files'}
      </button>
    </div>
  )
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return ''
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}
