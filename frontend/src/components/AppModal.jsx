import Modal from 'react-bootstrap/Modal'

// Shared modal chrome, so every dialog in the app opens the same way: an
// icon in a soft circle beside the title, a line of muted text saying what
// the dialog is for, a divider, the body, and a footer whose primary action
// sits right.
//
// `onSubmit` wraps header/body/footer in one <form>, which is what lets a
// footer button submit fields in the body. Without it the footer would need
// its own form or a click handler reaching across the dialog.

export default function AppModal({
  show = true,
  onHide,
  icon: Icon,
  title,
  subtitle,
  size,
  scrollable,
  fullscreen,
  onSubmit,
  /** Actions pinned to the left of the footer (e.g. "Save as draft"). */
  leadingActions,
  /** The footer's right-hand group: secondary outlines then the primary. */
  actions,
  bodyClassName = '',
  children,
}) {
  const content = (
    <>
      <Modal.Header closeButton className="app-modal__header">
        <div className="app-modal__heading">
          {Icon && (
            <span className="app-modal__icon" aria-hidden="true">
              <Icon size={20} />
            </span>
          )}
          <div className="app-modal__heading-text">
            {/* Kept as the h2 it has always been -- a dialog's title is what
                getByRole('heading') finds, and the subtitle below is a
                paragraph so it never competes for that. */}
            <Modal.Title as="h2" className="app-modal__title">
              {title}
            </Modal.Title>
            {subtitle && <p className="app-modal__subtitle">{subtitle}</p>}
          </div>
        </div>
      </Modal.Header>

      <Modal.Body className={`app-modal__body ${bodyClassName}`.trim()}>{children}</Modal.Body>

      {(actions || leadingActions) && (
        <Modal.Footer className="app-modal__footer">
          {leadingActions && <div className="app-modal__footer-leading">{leadingActions}</div>}
          <div className="app-modal__footer-actions">{actions}</div>
        </Modal.Footer>
      )}
    </>
  )

  return (
    <Modal
      show={show}
      onHide={onHide}
      centered
      size={size}
      scrollable={scrollable}
      fullscreen={fullscreen}
      contentClassName="app-modal"
    >
      {onSubmit ? (
        <form onSubmit={onSubmit} className="app-modal__form">
          {content}
        </form>
      ) : (
        content
      )}
    </Modal>
  )
}
