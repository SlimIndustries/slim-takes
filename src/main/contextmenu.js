'use strict';
// The right-click menu: Cut / Copy / Paste / Select all in text boxes, Copy on selected text.
// (Electron windows have no right-click menu until the app makes one.)

/** What to show for a right-click, from Electron's context-menu params. Empty = show nothing. */
function contextMenuTemplate(params = {}) {
  const f = params.editFlags || {};
  const hasText = !!(params.selectionText && params.selectionText.trim());
  if (params.isEditable) {
    return [
      { label: 'Cut', role: 'cut', enabled: f.canCut !== false && hasText },
      { label: 'Copy', role: 'copy', enabled: f.canCopy !== false && hasText },
      { label: 'Paste', role: 'paste', enabled: f.canPaste !== false },
      { type: 'separator' },
      { label: 'Select all', role: 'selectAll', enabled: f.canSelectAll !== false }
    ];
  }
  if (hasText) return [{ label: 'Copy', role: 'copy' }];
  return [];
}

module.exports = { contextMenuTemplate };
