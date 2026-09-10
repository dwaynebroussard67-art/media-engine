import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { v4 as uuidv4 } from 'uuid';
import { useStore } from '../store/useStore';
import { Upload, Trash2, ImageIcon, X } from 'lucide-react';
import toast from 'react-hot-toast';

export function Gallery() {
  const { gallery, addGalleryImage, removeGalleryImage } = useStore();
  const [preview, setPreview] = useState<string | null>(null);

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      acceptedFiles.forEach((file) => {
        if (!file.type.startsWith('image/')) {
          toast.error(`${file.name} is not an image`);
          return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          addGalleryImage({
            id: uuidv4(),
            url: dataUrl,
            dataUrl,
            name: file.name,
            uploadedAt: Date.now(),
          });
          toast.success(`${file.name} added to gallery!`);
        };
        reader.readAsDataURL(file);
      });
    },
    [addGalleryImage]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    multiple: true,
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-black text-slate-800 mb-1">Image Gallery</h2>
        <p className="text-slate-500 text-sm">
          Upload your ministry photos, graphics, and artwork. These inspire the AI-generated social media posts.
        </p>
      </div>

      {/* Drop Zone */}
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all ${
          isDragActive
            ? 'border-purple-500 bg-purple-50'
            : 'border-slate-300 hover:border-purple-400 hover:bg-slate-50'
        }`}
      >
        <input {...getInputProps()} />
        <div className="flex flex-col items-center gap-3">
          <div className={`p-4 rounded-full ${isDragActive ? 'bg-purple-100' : 'bg-slate-100'}`}>
            <Upload size={28} className={isDragActive ? 'text-purple-600' : 'text-slate-500'} />
          </div>
          <div>
            <p className={`font-bold text-lg ${isDragActive ? 'text-purple-700' : 'text-slate-700'}`}>
              {isDragActive ? 'Drop images here!' : 'Drag & drop images here'}
            </p>
            <p className="text-slate-500 text-sm">or click to browse your files</p>
          </div>
          <p className="text-xs text-slate-400">Supports JPG, PNG, GIF, WebP</p>
        </div>
      </div>

      {/* Stats */}
      {gallery.length > 0 && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <ImageIcon size={16} />
          <span><span className="font-bold text-slate-800">{gallery.length}</span> image{gallery.length !== 1 ? 's' : ''} in gallery</span>
        </div>
      )}

      {/* Gallery Grid */}
      {gallery.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {gallery.map((img) => (
            <div
              key={img.id}
              className="group relative rounded-xl overflow-hidden aspect-square bg-slate-100 border border-slate-200 hover:border-purple-300 transition-all shadow-sm"
            >
              <img
                src={img.dataUrl ?? img.url}
                alt={img.name}
                className="w-full h-full object-cover cursor-pointer"
                onClick={() => setPreview(img.dataUrl ?? img.url)}
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeGalleryImage(img.id);
                    toast.success('Image removed');
                  }}
                  className="opacity-0 group-hover:opacity-100 bg-red-500 hover:bg-red-600 text-white p-2 rounded-lg transition-all"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-all">
                <p className="text-white text-xs truncate font-medium">{img.name}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-slate-400">
          <ImageIcon size={40} className="mx-auto mb-3 opacity-40" />
          <p className="font-medium">No images yet</p>
          <p className="text-sm">Upload some images to get started</p>
        </div>
      )}

      {/* Preview Modal */}
      {preview && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setPreview(null)}
        >
          <div className="relative max-w-3xl w-full">
            <img src={preview} alt="Preview" className="w-full rounded-2xl" />
            <button
              onClick={() => setPreview(null)}
              className="absolute top-3 right-3 bg-white/20 hover:bg-white/40 text-white p-2 rounded-full"
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
