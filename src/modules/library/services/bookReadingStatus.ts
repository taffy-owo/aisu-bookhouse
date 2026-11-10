import type { Book, BrowserReaderAvailability } from '../../books';
import type { ReaderResource } from '../../reader/types/reader';

export type BookReadingStatusTone = 'accent' | 'danger' | 'success' | 'warning';

export type BookReadingStatus = {
  description: string;
  label: string;
  resourceLabel: string;
  tone: BookReadingStatusTone;
};

export function getBookReadingStatus(book: Book, resource: ReaderResource | null, availability: BrowserReaderAvailability, resourceLoadFailed = false): BookReadingStatus {
  if (book.status === 'uploading') {
    return {
      description: '文件正在上传到服务器，完成后会继续解析在线阅读资源。',
      label: '上传中',
      resourceLabel: '等待上传',
      tone: 'accent',
    };
  }

  if (book.status === 'processing') {
    return {
      description: '服务器正在解析正文、图片页或封面，完成后阅读入口会自动可用。',
      label: '正在解析',
      resourceLabel: '处理中',
      tone: 'accent',
    };
  }

  if (book.status === 'failed') {
    return {
      description: availability.reason ?? '文件已保存，但解析没有完成，可先下载原文件阅读。',
      label: '解析失败',
      resourceLabel: '仅原文件',
      tone: 'danger',
    };
  }

  if (book.readerType === 'unsupported') {
    return {
      description: availability.reason ?? '当前格式暂时不能在线解析，可先下载原文件阅读。',
      label: '暂不支持在线阅读',
      resourceLabel: '仅原文件',
      tone: 'danger',
    };
  }

  if (!resource) {
    if (resourceLoadFailed) {
      return {
        description: '资源信息暂时加载失败，可在目录处重试。',
        label: '资源读取失败',
        resourceLabel: '待重试',
        tone: 'warning',
      };
    }
    return {
      description: '正在读取在线阅读资源状态。',
      label: '正在确认资源',
      resourceLabel: '读取中',
      tone: 'accent',
    };
  }

  if ('fileUrl' in resource && resource.readerType === 'pdf') {
    if (resource.fileUrl && availability.canReadInBrowser) {
      return {
        description: 'PDF 原文件已可在浏览器中预览，也可以下载原文件。',
        label: 'PDF 预览已就绪',
        resourceLabel: 'PDF 原文件',
        tone: 'success',
      };
    }

    return {
      description: availability.reason ?? 'PDF 原文件还没有准备好，可稍后再试。',
      label: 'PDF 原文件未就绪',
      resourceLabel: '等待文件',
      tone: 'warning',
    };
  }

  if ('pages' in resource) {
    const totalPageCount = resource.pageCount || resource.pages.length;
    const readablePageCount = resource.pages.filter((page) => Boolean(page.imageUrl)).length;

    if (readablePageCount > 0) {
      return {
        description: `已生成 ${readablePageCount} 页在线图片，可直接在阅读器中翻阅。`,
        label: book.readerType === 'image' ? '图集页已就绪' : '漫画页已就绪',
        resourceLabel: totalPageCount && totalPageCount !== readablePageCount ? `${readablePageCount}/${totalPageCount} 页` : `${readablePageCount} 页`,
        tone: 'success',
      };
    }

    return {
      description: availability.reason ?? '图片页还没有完成解析，可先下载原文件阅读。',
      label: '图片页未就绪',
      resourceLabel: totalPageCount ? `${totalPageCount} 页记录` : '等待图片页',
      tone: 'warning',
    };
  }

  if ('chapterCount' in resource) {
    if (resource.chapterCount > 0) {
      return {
        description: `已提取 ${resource.chapterCount} 章正文目录，可继续在线阅读。`,
        label: '正文已就绪',
        resourceLabel: `${resource.chapterCount} 章`,
        tone: 'success',
      };
    }

    return {
      description: availability.reason ?? '这本书还没有可阅读的正文目录。',
      label: '正文目录未就绪',
      resourceLabel: '0 章',
      tone: 'warning',
    };
  }

  return {
    description: availability.reason ?? '当前资源状态还不能确认，可稍后刷新详情页。',
    label: availability.canReadInBrowser ? '可在线阅读' : '资源未就绪',
    resourceLabel: availability.canReadInBrowser ? '可阅读' : '等待资源',
    tone: availability.canReadInBrowser ? 'success' : 'warning',
  };
}
