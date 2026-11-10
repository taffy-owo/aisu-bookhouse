import { Cloud, FileText, ImageIcon, UploadCloud } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { SUPPORTED_FORMATS } from '../../../config/supportedFormats';
import { Button } from '../../../shared/components/Button';
import { cn } from '../../../shared/utils/cn';

interface UploadDropzoneProps {
  disabled?: boolean;
  fileInputRef?: RefObject<HTMLInputElement | null>;
  isUploading?: boolean;
  onFilesSelected: (files: File[]) => void;
}

export function UploadDropzone({ disabled = false, fileInputRef: externalFileInputRef, isUploading = false, onFilesSelected }: UploadDropzoneProps) {
  const localFileInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = externalFileInputRef ?? localFileInputRef;
  const [isDragging, setIsDragging] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const isDisabled = disabled || isUploading;

  const handleFiles = (fileList: FileList | null) => {
    if (isDisabled) {
      return;
    }

    const files = Array.from(fileList ?? []);

    if (files.length === 0) {
      return;
    }

    setSelectedCount(files.length);
    onFilesSelected(files);
  };

  return (
    <div className="upload-dropzone">
      <div
        className={cn(
          'rounded-[24px] border border-dashed border-[#F3B4AE] bg-[#FFF8F6] p-5 text-center transition sm:rounded-[32px] sm:p-8 lg:rounded-2xl lg:p-5 dark:border-accent/30 dark:bg-night',
          isDragging && 'border-accent bg-[#FFF0EF] shadow-soft dark:bg-plum/30',
        )}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (isDisabled) {
            return;
          }
          setIsDragging(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (isDisabled) {
            return;
          }
          handleFiles(event.dataTransfer.files);
        }}
      >
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white text-accent shadow-sm sm:h-16 sm:w-16 sm:rounded-3xl lg:h-11 lg:w-11 lg:rounded-xl dark:bg-night">
          <UploadCloud className="h-6 w-6 sm:h-7 sm:w-7" />
        </div>
        <h1 className="app-page-title mt-4 font-display text-2xl font-semibold sm:mt-5 sm:text-3xl lg:mt-3">拖拽文件到这里</h1>
        <p className="mx-auto mt-2 max-w-xl text-xs leading-6 text-stone-500 sm:mt-3 sm:text-sm sm:leading-7">
          文件会保存到你的私人书架，并自动生成封面、目录和阅读页面。
        </p>
        <input
          aria-label="选择图书文件"
          tabIndex={-1}
          accept=".epub,.mobi,.txt,.pdf,.cbz,.zip,.jpg,.jpeg,.png,.webp,.avif,.gif,.bmp,.jfif"
          className="sr-only"
          disabled={isDisabled}
          multiple
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          }}
          ref={fileInputRef}
          type="file"
        />
        <Button className="mt-4 sm:mt-6" disabled={isDisabled} onClick={() => fileInputRef.current?.click()}>
          {isUploading ? '上传中...' : '选择文件'}
        </Button>
        {selectedCount > 0 && <p className="mt-3 text-xs text-accent">已选择 {selectedCount} 个文件</p>}
      </div>
      <div className="upload-format-grid mt-4 grid grid-cols-2 gap-3 sm:mt-7 lg:mt-4 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        {[
          [FileText, '电子书', 'EPUB / MOBI / TXT'],
          [FileText, 'PDF', '在线阅读 / 下载原文件'],
          [ImageIcon, '漫画', 'CBZ / ZIP'],
          [Cloud, '图片', 'JPG / PNG / WEBP'],
        ].map(([Icon, title, description]) => {
          const FormatIcon = Icon as typeof FileText;

          return (
            <div className="rounded-2xl border border-stone-200 bg-white p-3 sm:rounded-3xl sm:p-4 dark:border-white/10 dark:bg-white/[0.02]" key={String(title)}>
              <FormatIcon className="mb-3 h-5 w-5 text-accent sm:mb-4" />
              <div className="font-medium">{String(title)}</div>
              <div className="mt-1 text-xs text-stone-500">{String(description)}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {SUPPORTED_FORMATS.map((format) => (
          <span className="rounded-full bg-white px-3 py-1 text-xs text-stone-500 shadow-sm dark:bg-white/5 dark:text-stone-400" key={format}>
            {format}
          </span>
        ))}
      </div>
    </div>
  );
}
