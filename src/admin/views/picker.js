import { ICON_CLOSE } from '../../render/icons.js';

// 媒体库选择器（编辑器插图与设置页首页封面共用）。id 固定：两侧的 JS 都按这套 id 接线。
// 文案可传：编辑器说「插入」，首页封面说「选择」。
export const pickerDialog = ({ title = '从媒体库插入' } = {}) => `    <dialog class="a-modal a-picker" id="a-picker" data-dismiss-outside aria-labelledby="a-picker-title">
      <div class="a-picker-head">
        <h2 class="a-modal-title" id="a-picker-title">${title}</h2>
        <div class="a-picker-head-actions"><button type="button" class="a-btn-ghost" id="a-picker-upload">上传新文件</button><button type="button" class="a-media-icon" data-picker-cancel aria-label="关闭媒体库">${ICON_CLOSE}</button></div>
      </div>
      <div class="a-picker-body" id="a-picker-body"><p class="a-dim" role="status">正在读取媒体库…</p></div>
      <div class="a-modal-actions">
        <button type="button" class="a-btn-ghost" data-picker-cancel>取消</button>
      </div>
    </dialog>`;
