// Helper for browser-side mounting in e2e tests.
import './files.css';
import React, { type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionBridge } from '../contract';
import { EmptyState } from './EmptyState';
import { MapDropZone } from './MapDropZone';
import { OpenMapButton } from './OpenMapButton';
import { PdfPagePicker } from './PdfPagePicker';

export interface MountedComponent {
  readonly root: Root;
  readonly unmount: () => void;
}

export function mountEmptyState(container: HTMLElement, bridge: SessionBridge): MountedComponent {
  const root = createRoot(container);
  root.render(React.createElement(EmptyState, { bridge }));
  return {
    root,
    unmount: () => root.unmount(),
  };
}

export function mountMapDropZone(
  container: HTMLElement,
  bridge: SessionBridge,
  children?: ReactNode
): MountedComponent {
  const root = createRoot(container);
  root.render(
    React.createElement(MapDropZone, {
      bridge,
      children: children ?? React.createElement(EmptyState, { bridge }),
    })
  );
  return {
    root,
    unmount: () => root.unmount(),
  };
}

export function mountOpenMapButton(
  container: HTMLElement,
  bridge: SessionBridge,
  id?: string
): MountedComponent {
  const root = createRoot(container);
  root.render(React.createElement(OpenMapButton, { bridge, id }));
  return {
    root,
    unmount: () => root.unmount(),
  };
}

export function mountPdfPagePicker(container: HTMLElement, bridge: SessionBridge): MountedComponent {
  const root = createRoot(container);
  root.render(React.createElement(PdfPagePicker, { bridge }));
  return {
    root,
    unmount: () => root.unmount(),
  };
}
