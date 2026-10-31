import React from 'react';

/** Draws every segment's progress as a slice of one bar, IDM-style. */
export default function SegmentBar({ job, height = 8 }) {
  const size = job.size || 0;
  const segs = job.segments || [];

  if (!size || segs.length === 0) {
    const pct = job.status === 'completed' ? 100 : 0;
    return (
      <div className={'segbar ' + (job.status === 'downloading' ? 'indeterminate' : '')} style={{ height }}>
        <div className="seg fill" style={{ left: 0, width: pct + '%' }} />
      </div>
    );
  }

  return (
    <div className="segbar" style={{ height }} title={segs.length + ' segments'}>
      {segs.map((s, i) => {
        const span = s.end - s.start + 1;
        const left = (s.start / size) * 100;
        const width = (span / size) * 100;
        const done = Math.min(1, s.downloaded / span);
        return (
          <React.Fragment key={i}>
            <div className="seg bg" style={{ left: left + '%', width: width + '%' }} />
            <div className="seg fill" style={{ left: left + '%', width: width * done + '%' }} />
          </React.Fragment>
        );
      })}
    </div>
  );
}
