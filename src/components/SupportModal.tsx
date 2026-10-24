import React from 'react';

export const SupportModal: React.FC<{ onClose: () => void }> = ({ onClose }) => (
        <div className="ais-modal-backdrop" onClick={onClose}>
          <div className="ais-support-modal" onClick={e => e.stopPropagation()}>
            <div className="ais-support-modal-header">
              <span className="ais-support-modal-title">Feedback & Support</span>
              <button
                type="button"
                className="ais-card-close-btn"
                onClick={onClose}
                title="Close"
              >
                ✕
              </button>
            </div>
            <div className="ais-support-modal-body">
              <p>
                <strong>Your feedback matters most!</strong> I would love to hear your thoughts, feature ideas, or bug reports to make this tactical AIS monitor even better for real-world navigation.
              </p>
              <p>
                I&apos;m personally investing time and resources into building and refining this tool — featuring ARPA CPA/TCPA collision alarms, COLREGs crossing rules, anchor drag alerts, and weather radar overlay.
              </p>
              <p>
                Infrastructure and testing costs have reached <strong>€40</strong> so far. Additional funding allows new features to be added much faster — but even a simple email with your feedback means a lot!
              </p>
              <a
                href="mailto:refuso.chiari.1j@icloud.com?subject=Rotevista%20dash%3A%20Improvement"
                className="ais-support-email-btn"
              >
                ✉️ Contact Developer
              </a>
            </div>
          </div>
        </div>
);
