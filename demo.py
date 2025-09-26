from flask import Flask, request, jsonify
import os

app = Flask(__name__)

# 获取目录下的文件夹和文件
def get_directory_list(path):
    try:
        # 获取路径下的所有文件和文件夹
        items = os.listdir(path)
        result = []
        for item in items:
            item_path = os.path.join(path, item)
            item_info = {"name": item, "path": item_path}
            
            if os.path.isdir(item_path):
                item_info["type"] = "folder"
            else:
                item_info["type"] = "file"
                
            result.append(item_info)
        return result
    except Exception as e:
        return {"error": str(e)}

@app.route('/list', methods=['GET'])
def list_directory():
    path = request.args.get('path', '/')
    if not os.path.exists(path):
        return jsonify({"error": "路径不存在"}), 404

    # 获取目录下的文件和文件夹列表
    directories = get_directory_list(path)
    return jsonify(directories)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=8080)
